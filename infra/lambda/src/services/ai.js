"use strict";

const {
  CHAT_SYSTEM_PROMPT,
  CHAT_CONTEXT_CHAR_LIMIT,
  CHAT_DEFAULT_MAX_TOKENS,
  HIGHLIGHT_SYSTEM_PROMPT,
  HIGHLIGHT_MAX_TOKENS,
} = require("../utils/constants");

/**
 * Format chat history for AI providers
 */
function formatHistoryForProvider(history) {
  return history.map((msg) => ({
    role: msg.role === "ASSISTANT" ? "assistant" : "user",
    content: msg.content || "",
  }));
}

/**
 * Call Gemini API for chat
 */
async function callGemini(model, contextText, history, userMessage, maxTokens, traceId) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.SAFEPOCKET_AI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[chat] Gemini requested but no API key configured");
    return null;
  }
  
  const base = (process.env.SAFEPOCKET_AI_ENDPOINT || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const url = `${base}/${modelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const contents = [];
  contents.push({
    role: "user",
    parts: [{ text: `Context JSON:\n${contextText}` }],
  });
  
  history.forEach((msg) => {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    });
  });
  contents.push({ role: "user", parts: [{ text: userMessage }] });
  
  const payload = {
    systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens, 2048),
      temperature: 0.6,
    },
  };
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    if (!res.ok) {
      const text = await res.text();
      console.warn("[chat] Gemini response not ok", { status: res.status, body: text });
      return null;
    }
    
    const data = await res.json();
    if (Array.isArray(data.candidates) && data.candidates.length > 0) {
      const candidate = data.candidates.find((c) => c.content?.parts?.length) || data.candidates[0];
      if (candidate?.content?.parts?.length) {
        const textPart = candidate.content.parts.find((part) => typeof part.text === "string");
        if (textPart?.text) return textPart.text.trim();
      }
    }
    return null;
  } catch (error) {
    console.warn("[chat] Gemini call failed", { message: error?.message, traceId });
    return null;
  }
}

/**
 * Call OpenAI API for chat
 */
async function callOpenAi(model, contextText, history, userMessage, maxTokens, traceId) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.SAFEPOCKET_AI_KEY;
  if (!apiKey) {
    console.warn("[chat] OpenAI requested but no API key configured");
    return null;
  }
  
  const endpoint = (process.env.SAFEPOCKET_AI_ENDPOINT || "https://api.openai.com/v1/responses").replace(/\/+$/, "");
  const input = [
    {
      role: "system",
      content: [{ type: "text", text: CHAT_SYSTEM_PROMPT }],
    },
    {
      role: "system",
      content: [{ type: "text", text: `Context JSON:\n${contextText}` }],
    },
  ];
  
  history.forEach((msg) => {
    input.push({
      role: msg.role,
      content: [{ type: "text", text: msg.content }],
    });
  });
  input.push({
    role: "user",
    content: [{ type: "text", text: userMessage }],
  });
  
  const payload = {
    model,
    input,
    max_output_tokens: maxTokens,
  };
  
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    
    if (!res.ok) {
      const text = await res.text();
      console.warn("[chat] OpenAI response not ok", { status: res.status, body: text });
      return null;
    }
    
    const data = await res.json();
    if (typeof data.output_text === "string" && data.output_text.trim().length > 0) {
      return data.output_text.trim();
    }
    if (Array.isArray(data.output)) {
      const parts = [];
      for (const item of data.output) {
        if (item?.content) {
          for (const part of item.content) {
            const text = part?.text || part?.output_text;
            if (typeof text === "string") parts.push(text);
          }
        }
      }
      if (parts.length > 0) return parts.join("\n").trim();
    }
    return null;
  } catch (error) {
    console.warn("[chat] OpenAI call failed", { message: error?.message, traceId });
    return null;
  }
}

/**
 * Call AI assistant (selects provider based on config)
 */
async function callAiAssistant(history, userMessage, context, traceId) {
  const provider = (process.env.SAFEPOCKET_AI_PROVIDER || "gemini").toLowerCase();
  const model = process.env.SAFEPOCKET_AI_MODEL || (provider === "gemini" ? "gemini-2.5-flash" : "gpt-4.1-mini");
  const maxTokens = CHAT_DEFAULT_MAX_TOKENS;
  
  const contextJson = JSON.stringify(context, null, 2);
  const contextText = contextJson.length > CHAT_CONTEXT_CHAR_LIMIT
    ? `${contextJson.slice(0, CHAT_CONTEXT_CHAR_LIMIT)}\n[context truncated]`
    : contextJson;
    
  const formattedHistory = formatHistoryForProvider(history);
  
  if (provider === "gemini") {
    return callGemini(model, contextText, formattedHistory, userMessage, maxTokens, traceId);
  }
  return callOpenAi(model, contextText, formattedHistory, userMessage, maxTokens, traceId);
}

/**
 * Call Gemini for highlight generation
 */
async function callGeminiHighlight(model, prompt, maxTokens, traceId) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.SAFEPOCKET_AI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[analytics] Gemini highlight requested but no API key configured");
    return null;
  }
  
  const base = (process.env.SAFEPOCKET_AI_ENDPOINT || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const url = `${base}/${modelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const payload = {
    systemInstruction: { parts: [{ text: HIGHLIGHT_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens, 2048),
      temperature: 0.35,
      responseMimeType: "application/json",
    },
  };
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    if (!res.ok) {
      const text = await res.text();
      console.warn("[analytics] Gemini highlight response not ok", { status: res.status, body: text });
      return null;
    }
    
    const data = await res.json();
    if (Array.isArray(data.candidates) && data.candidates.length > 0) {
      for (const candidate of data.candidates) {
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (typeof part.text === "string" && part.text.trim()) {
              return part.text.trim();
            }
            if (part.json) {
              try { return JSON.stringify(part.json); } catch { /* ignore */ }
            }
          }
        }
      }
    }
    return null;
  } catch (error) {
    console.warn("[analytics] Gemini highlight call failed", { message: error?.message, traceId });
    return null;
  }
}

/**
 * Call OpenAI for highlight generation
 */
async function callOpenAiHighlight(model, prompt, maxTokens, traceId) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.SAFEPOCKET_AI_KEY;
  if (!apiKey) {
    console.warn("[analytics] OpenAI highlight requested but no API key configured");
    return null;
  }
  
  const endpoint = (process.env.SAFEPOCKET_AI_ENDPOINT || "https://api.openai.com/v1/responses").replace(/\/+$/, "");
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "text", text: HIGHLIGHT_SYSTEM_PROMPT }] },
      { role: "user", content: [{ type: "text", text: prompt }] },
    ],
    max_output_tokens: Math.min(maxTokens, 1000),
    temperature: 0.35,
  };
  
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    
    if (!res.ok) {
      const text = await res.text();
      console.warn("[analytics] OpenAI highlight response not ok", { status: res.status, body: text });
      return null;
    }
    
    const data = await res.json();
    if (Array.isArray(data.output_text) && data.output_text.length > 0) {
      return data.output_text.join("\n").trim();
    }
    if (Array.isArray(data.output) && data.output.length > 0) {
      const first = data.output[0];
      if (Array.isArray(first?.content) && first.content.length > 0) {
        const textNode = first.content.find((part) => typeof part.text === "string" && part.text.trim());
        if (textNode?.text) return textNode.text.trim();
      }
    }
    return null;
  } catch (error) {
    console.warn("[analytics] OpenAI highlight call failed", { message: error?.message, traceId });
    return null;
  }
}

/**
 * Check if Gemini credentials are available
 */
function hasGeminiCredentials() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.SAFEPOCKET_AI_KEY || process.env.OPENAI_API_KEY);
}

/**
 * Check if OpenAI credentials are available
 */
function hasOpenAiCredentials() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.SAFEPOCKET_AI_KEY);
}

module.exports = {
  callGemini,
  callOpenAi,
  callAiAssistant,
  callGeminiHighlight,
  callOpenAiHighlight,
  formatHistoryForProvider,
  hasGeminiCredentials,
  hasOpenAiCredentials,
};
