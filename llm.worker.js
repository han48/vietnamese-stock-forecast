/**
 * llm.worker.js — LLM inference via transformers.js v4 + WebGPU
 * Model: onnx-community/Qwen3-0.6B-ONNX
 * Worker type: module  →  new Worker("llm.worker.js", { type: "module" })
 *
 * v2: Upgraded to transformers v4, direct model class, KV cache for multi-turn.
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
let pastKeyValues = null;   // cached KV from previous generation
let promptHistory = "";     // raw prompt text built up across turns

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
  promptHistory = "";
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

// ── Generate (with KV cache) ─────────────────────────────────────────────────
async function generate({ messages, enableThinking = true }) {
  if (!model || !tokenizer) {
    console.error("[LLM] not ready");
    return;
  }

  stopping.reset();
  let numTokens = 0;
  let startTime;
  let tps;

  // Build the current turn's prompt using chat template
  const turnPrompt = tokenizer.apply_chat_template(messages, {
    tokenize: false,
    add_generation_prompt: true,
    enable_thinking: enableThinking,
  });

  // Determine if we can reuse KV cache
  const isFirstTurn = promptHistory === "";
  let fullPrompt;
  let inputs;

  if (!isFirstTurn && pastKeyValues && turnPrompt.startsWith(promptHistory)) {
    // Continuation: only encode the new part, reuse past KV
    // This is faster because the model doesn't re-process the entire history
    fullPrompt = turnPrompt;
    inputs = tokenizer(fullPrompt);
  } else {
    // First turn or context changed (system prompt changed): full encode
    disposePastKeyValues();
    fullPrompt = turnPrompt;
    inputs = tokenizer(fullPrompt);
  }

  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,   // keep <think> tags so UI can parse them
    callback_function(token) {
      startTime ??= performance.now();
      if (numTokens++ > 0) {
        tps = (numTokens / (performance.now() - startTime)) * 1000;
      }
      // Strip im_start/im_end special tokens, keep <think></think>
      const clean = token.replace(/<\|im_end\|>/g, "").replace(/<\|im_start\|>/g, "");
      if (clean) self.postMessage({ status: "update", output: clean, tps, numTokens });
    },
  });

  self.postMessage({ status: "start" });
  console.log("[LLM] generating, thinking:", enableThinking, "kv_cached:", !!pastKeyValues);

  const generateArgs = {
    ...inputs,
    max_new_tokens: enableThinking ? 1024 : 512,
    do_sample: false,
    streamer,
    stopping_criteria: stopping,
    return_dict_in_generate: true,
  };

  // Pass KV cache if available
  if (pastKeyValues) {
    generateArgs.past_key_values = pastKeyValues;
  }

  const result = await model.generate(generateArgs);

  // Update KV cache for next turn
  pastKeyValues = result.past_key_values;

  // Decode the full sequence to maintain prompt history for next turn
  const fullSequenceText = tokenizer.batch_decode(result.sequences, {
    skip_special_tokens: false,
  })[0];
  promptHistory = fullSequenceText;

  console.log("[LLM] generate done, tokens:", numTokens);
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