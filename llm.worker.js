/**
 * llm.worker.js — LLM inference via transformers.js v4 + WebGPU
 * Model: onnx-community/Qwen3-0.6B-ONNX
 * Worker type: module  →  new Worker("llm.worker.js", { type: "module" })
 *
 * v4: Always inject system prompt. KV cache reuse only when system prompt
 *     is unchanged between turns. Manual prompt building for KV compatibility.
 */

import {
  AutoModelForCausalLM,
  AutoTokenizer,
  TextStreamer,
  InterruptableStoppingCriteria,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

const MODEL_ID = "onnx-community/Qwen3-0.6B-ONNX";

/* ─── State ─── */
let tokenizer = null;
let model     = null;
const stopping = new InterruptableStoppingCriteria();

// KV cache state
let pastKeyValues    = null;
let promptHistory    = "";   // full decoded text from all prior turns
let lastSystemPrompt = "";   // detect system prompt changes → invalidate KV

function errMsg(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function disposePastKeyValues() {
  if (pastKeyValues) {
    for (const tensor of Object.values(pastKeyValues)) {
      tensor.dispose();
    }
    pastKeyValues = null;
  }
  promptHistory    = "";
  lastSystemPrompt = "";
}

// ── Cache check ───────────────────────────────────────────────────────────────
async function checkCache() {
  try {
    if (!("caches" in self)) { self.postMessage({ status: "cache_result", cached: false }); return; }
    const cache = await caches.open("transformers-cache");
    const keys  = await cache.keys();
    const found = keys.some(r => r.url.includes("Qwen3-0.6B"));
    self.postMessage({ status: "cache_result", cached: found });
  } catch {
    self.postMessage({ status: "cache_result", cached: false });
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function load() {
  console.log("[LLM] load() start — device=webgpu, dtype=q4f16");
  self.postMessage({ status: "loading", data: "Đang tải model (WebGPU)…" });

  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
    progress_callback(info) {
      if (["initiate", "progress", "done"].includes(info.status)) {
        self.postMessage(info);
      }
    },
  });

  model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
    dtype: "q4f16",
    device: "webgpu",
    progress_callback(info) {
      if (["initiate", "progress", "done"].includes(info.status)) {
        self.postMessage(info);
      }
    },
  });

  console.log("[LLM] model ready");
  self.postMessage({ status: "ready" });
}

// ── Generate ─────────────────────────────────────────────────────────────────
//
// Each call receives the full messages array from app.js:
//   [{ role:"system", content:"..." }, { role:"user", content:"..." }]
//
// Strategy:
//   - System prompt contains dynamic data (forecast, DB) that changes per turn.
//   - If system prompt is SAME as last turn → reuse KV cache (fast continuation).
//   - If system prompt CHANGED → dispose KV, rebuild from scratch.
//   - Prompt is always built manually with special tokens for KV compatibility.
//
async function generate({ messages, enableThinking = true }) {
  if (!model || !tokenizer) {
    console.error("[LLM] not ready");
    return;
  }

  stopping.reset();
  let numTokens = 0;
  let startTime;
  let tps;

  // ── Extract messages ──
  const systemMsg   = messages.find(m => m.role === "system");
  const turnMsgs    = messages.filter(m => m.role !== "system"); // user/assistant pairs
  const systemContent = systemMsg?.content || "";
  const userContent   = turnMsgs.filter(m => m.role === "user").pop()?.content || "";

  // ── Check if system prompt changed → invalidate KV ──
  const systemChanged = lastSystemPrompt !== "" && systemContent !== lastSystemPrompt;
  if (systemChanged) {
    console.log("[LLM] system prompt changed — disposing KV cache");
    disposePastKeyValues();
  }

  const canReuse = !systemChanged && pastKeyValues && promptHistory !== "";

  // ── Build prompt ──
  let fullPrompt;

  if (canReuse) {
    // Continuation turn: append only the latest user turn to existing history
    // System prompt + prior turns are already baked into KV cache
    const newTurn =
      `<|im_start|>user\n${userContent}<|im_end|>\n` +
      (enableThinking
        ? "<|im_start|>assistant\n<think>\n"
        : "<|im_start|>assistant\n<think>\n\n</think>\n\n");

    fullPrompt = promptHistory + "\n" + newTurn;
  } else {
    // Fresh start: build full prompt with system + all history turns
    let parts = [];

    if (systemContent) {
      parts.push(`<|im_start|>system\n${systemContent}<|im_end|>`);
    }

    // Include all conversation turns from history (user/assistant pairs)
    for (const msg of turnMsgs) {
      if (msg.role === "user") {
        parts.push(`<|im_start|>user\n${msg.content}<|im_end|>`);
      } else if (msg.role === "assistant") {
        parts.push(`<|im_start|>assistant\n${msg.content}<|im_end|>`);
      }
    }

    // If the last turn was user, add assistant generation prompt
    const lastRole = turnMsgs[turnMsgs.length - 1]?.role;
    if (lastRole === "user" || !lastRole) {
      // Remove the trailing <|im_end|> from last user msg — we already added it
      // Now add assistant prompt with thinking control
      parts.push(enableThinking
        ? "<|im_start|>assistant\n<think>\n"
        : "<|im_start|>assistant\n<think>\n\n</think>\n\n");
    }

    fullPrompt = parts.join("\n");
    lastSystemPrompt = systemContent;
  }

  console.log("[LLM] generating — thinking:", enableThinking,
    "kv_reuse:", canReuse, "prompt_len:", fullPrompt.length);

  const inputs = tokenizer(fullPrompt);
  const generateArgs = { ...inputs };

  if (canReuse) {
    generateArgs.past_key_values = pastKeyValues;
  }

  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function(token) {
      startTime ??= performance.now();
      if (numTokens++ > 0) {
        tps = (numTokens / (performance.now() - startTime)) * 1000;
      }
      const clean = token.replace(/<\|im_end\|>/g, "").replace(/<\|im_start\|>/g, "");
      if (clean) self.postMessage({ status: "update", output: clean, tps, numTokens });
    },
  });

  self.postMessage({ status: "start" });

  const result = await model.generate({
    ...generateArgs,
    max_new_tokens: enableThinking ? 1024 : 512,
    do_sample: false,
    streamer,
    stopping_criteria: stopping,
    return_dict_in_generate: true,
  });

  // ── Save state for next turn ──
  pastKeyValues = result.past_key_values;
  promptHistory = tokenizer.batch_decode(result.sequences, {
    skip_special_tokens: false,
  })[0];

  console.log("[LLM] done, tokens:", numTokens);
  self.postMessage({ status: "complete", numTokens, tps });
}

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = async ({ data: { type, data } }) => {
  console.log("[LLM] msg:", type);
  try {
    switch (type) {
      case "check_cache": await checkCache();       break;
      case "load":        await load();             break;
      case "generate":    await generate(data);     break;
      case "interrupt":   stopping.interrupt();     break;
      case "reset":       stopping.reset();
                          disposePastKeyValues();   break;
      case "reset_kv":    disposePastKeyValues();   break;
    }
  } catch (e) {
    console.error("[LLM] error in", type, e);
    self.postMessage({ status: "error", message: errMsg(e) });
  }
};