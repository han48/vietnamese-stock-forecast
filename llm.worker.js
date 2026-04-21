/**
 * llm.worker.js — LLM inference via transformers.js + WebGPU
 * Model: onnx-community/Qwen3-0.6B-ONNX
 * Worker type: module  →  new Worker("llm.worker.js", { type: "module" })
 */

import {
  pipeline,
  TextStreamer,
  InterruptableStoppingCriteria,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js";

const MODEL_ID = "onnx-community/Qwen3-0.6B-ONNX";

env.allowRemoteModels = true;
env.allowLocalModels  = false;

let generator = null;
const stopping = new InterruptableStoppingCriteria();

function errMsg(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
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

  generator = await pipeline("text-generation", MODEL_ID, {
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

// ── Generate ──────────────────────────────────────────────────────────────────
async function generate({ messages, enableThinking = true }) {
  if (!generator) {
    console.error("[LLM] not ready");
    return;
  }

  stopping.reset();
  let numTokens = 0;
  let startTime;
  let tps;

  // Build prompt manually so we can pass enable_thinking to chat template
  const prompt = generator.tokenizer.apply_chat_template(messages, {
    tokenize: false,
    add_generation_prompt: true,
    enable_thinking: enableThinking,
  });

  const streamer = new TextStreamer(generator.tokenizer, {
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
  console.log("[LLM] generating, thinking:", enableThinking);

  // Pass the rendered string prompt (not messages array) so template is not re-applied
  await generator(prompt, {
    max_new_tokens: enableThinking ? 1024 : 512,
    do_sample: false,
    return_full_text: false,
    streamer,
    stopping_criteria: stopping,
  });

  console.log("[LLM] generate done, tokens:", numTokens);
  self.postMessage({ status: "complete" });
}

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = async ({ data: { type, data } }) => {
  console.log("[LLM] msg:", type);
  try {
    switch (type) {
      case "check_cache": await checkCache();    break;
      case "load":        await load();          break;
      case "generate":    await generate(data);  break;
      case "interrupt":   stopping.interrupt();  break;
      case "reset":       stopping.reset();      break;
    }
  } catch (e) {
    console.error("[LLM] error in", type, e);
    self.postMessage({ status: "error", message: errMsg(e) });
  }
};
