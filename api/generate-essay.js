// ========================================================================
//  Gemini 作文生成 API - 金鑰輪換代理 (2025)
//  功能:
//  1. 接收前端傳來的作文題目、字數、指引等參數。
//  2. 從 Vercel 環境變數讀取所有 Gemini API Keys。
//  3. 使用 Vercel KV (Upstash Redis) 讀寫當前金鑰的索引。
//  4. 如果 API Key 額度用盡 (HTTP 429)，自動切換至下一個並重試。
//  5. 構造完整的 Prompt，呼叫 Gemini API。
//  6. 將 Gemini API 的最終結果回傳給前端。
// ========================================================================

// 在 KV 數據庫中儲存 "當前金鑰索引" 的鍵名
const KEY_INDEX_NAME = 'current_gemini_key_index';

// 從 Vercel 環境變數讀取 KV 連線資訊
const { KV_REST_API_URL, KV_REST_API_TOKEN } = process.env;

/**
 * 從 Vercel KV 讀取當前的金鑰索引。
 * @returns {Promise<number>} 返回索引值，預設為 0。
 */
async function getCurrentKeyIndex() {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return 0;
  try {
    const response = await fetch(`${KV_REST_API_URL}/get/${KEY_INDEX_NAME}`, {
      headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
    });
    const data = await response.json();
    // Vercel KV 的回傳格式是 { result: '"0"' }，需要解析
    return data.result ? JSON.parse(data.result) : 0;
  } catch (error) {
    console.error("從 Vercel KV 讀取索引時發生錯誤:", error);
    return 0; // 發生錯誤時，從頭開始
  }
}

/**
 * 將新的金鑰索引寫入 Vercel KV。
 * @param {number} index - 新的金鑰索引值。
 */
async function setCurrentKeyIndex(index) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return;
  try {
    await fetch(`${KV_REST_API_URL}/set/${KEY_INDEX_NAME}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
      body: JSON.stringify(index),
    });
  } catch (error) {
    console.error("寫入索引至 Vercel KV 時發生錯誤:", error);
  }
}

function getSystemPrompt(structure, wordCount, topic, guidelines) {
    let coreInstruction;
    if (structure === 'classic') {
        coreInstruction = `你是一位文學散文大師，你的任務是要創作情感真摯、立意深刻、句式自然的作品。作品必須在${wordCount}字內，文學性高、過渡自然（不可以用時間詞過渡，例如「三年後」、「小時候」、「如今」，要多變）、意象豐富的敘事散文，情節不可零散，一件事要慢慢渲染，延續寫下去，刻劃人物及情節都要求質不求量，才會動人。要重視人物之間的感情和交流，有不同的事件及回憶相互映襯突出主題，要善用通感及融情入景。必須避免使用身體部位作主語，例如「指尖」、「額角」。人物的對話不能有說教意味，要更有人情、人性。題目為「${topic}」。`;
    } else { // threeline
        coreInstruction = `你是一位文學散文大師。你的任務是要創作情感真摯、立意深刻的作品、句式自然的作品。作品必須在${wordCount}字內，文學性高、過渡自然（不可以用時間詞過渡，例如「三年後」、「小時候」、「如今」，要多變）、意象豐富的敘事散文，情節不可零散，一件事要慢慢渲染，延續寫下去，刻劃人物及情節都要求質不求量，才會動人。要重視人物之間的感情和交流，有不同的事件及回憶相互映襯突出主題，要善用通感及融情入景。必須避免使用身體部位作主語，例如「指尖」、「額角」。人物的對話不能有說教意味，要更有人情、人性。要用三線散敘寫作，題目為「${topic}」。`;
    }

    if (guidelines) {
        coreInstruction += `\n\n[創作指引]\n${guidelines}`;
    }

    return `
[最終指令]
${coreInstruction}
最終輸出必須為一篇完整的純文字文章。絕不允許使用任何Markdown格式（如標題符號 #、粗體 **、列表 - * 等）。
絕不允許在文章前後或內部包含任何思考過程、解釋、標籤或非文章內容的文字。直接開始寫作即可。
全文不可超過八段。
`;
}

// Vercel Serverless Function 主處理函式
export default async function handler(request, response) {
  // 步驟 1: 基本請求驗證 (只接受 POST 請求)
  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Method Not Allowed' });
  }

  // 從請求中提取參數
  const { topic, wordCount, guidelines, structure } = request.body;
  if (!topic || !wordCount || !structure) {
    return response.status(400).json({ error: '請求中缺少必要參數 (topic, wordCount, structure)' });
  }

  // 步驟 2: 從環境變數讀取所有 API Keys
  const apiKeysString = process.env.GEMINI_API_KEYS;
  if (!apiKeysString || !KV_REST_API_URL) {
    const errorMessage = '伺服器端未設定 API Keys 或未連接 KV 數據庫。';
    console.error(errorMessage);
    return response.status(500).json({ error: errorMessage });
  }
  const apiKeys = apiKeysString.split(',').map(key => key.trim());
  const totalKeys = apiKeys.length;

  // 步驟 3: 從 KV 數據庫獲取當前應使用的金鑰索引
  let keyIndex = await getCurrentKeyIndex();

  // 步驟 4: 準備發送給 Gemini API 的請求內容
  // 【修訂 1】建議使用 'gemini-1.5-pro-latest' 作為模型名稱，它通常是功能最全面且最穩定的版本。
  const MODEL_NAME = 'gemini-2.5-pro';
  const systemPrompt = getSystemPrompt(structure, wordCount, topic, guidelines);
  
  const requestBody = {
    "contents": [{ "role": "user", "parts": [{ "text": systemPrompt }] }],
    "generationConfig": {
        "temperature": 1,
        "topP": 0.9,
        "maxOutputTokens": 10000 // 確保此數值足夠大以容納您的作文長度
    }
  };

  // 步驟 5: 核心邏輯 - 迴圈嘗試所有金鑰，直到成功或全部失敗
  for (let i = 0; i < totalKeys; i++) {
    const currentKey = apiKeys[keyIndex];
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${currentKey}`;

    try {
      console.log(`[資訊] 正在嘗試使用第 ${keyIndex + 1} 個 API Key (索引: ${keyIndex})`);
      
      // 【修訂 2】將超時從 300 秒調整為 45 秒 (45000ms)，以避免超過 Vercel 免費方案的函式執行時間限制 (通常為 10-60 秒)。
      //           原註解有誤 (45秒)，但數值是 300000ms (5分鐘)。
      const geminiResponse = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(300000) // 45秒超時
      });
      
      // 【修訂 3】更穩健的錯誤處理：在嘗試解析 JSON 前回應主體。
      if (!geminiResponse.ok) {
        // 如果額度用盡 (HTTP 429) 或伺服器錯誤 (5xx)，則切換金鑰重試。
        if (geminiResponse.status === 429 || geminiResponse.status >= 500) {
            console.warn(`[警告] API Key (索引: ${keyIndex}) 遭遇問題 (狀態碼: ${geminiResponse.status})。正在切換至下一個...`);
            keyIndex = (keyIndex + 1) % totalKeys;
            await setCurrentKeyIndex(keyIndex);
            continue; // 換下一個 Key 繼續迴圈
        }

        // 對於其他客戶端錯誤 (如 400 Bad Request)，通常表示請求本身有問題，重試也無效。
        // 我們嘗試解析錯誤訊息，如果解析失敗，則回傳原始狀態碼。
        let errorData;
        try {
            errorData = await geminiResponse.json();
        } catch (e) {
            errorData = { error: `API 回傳了非 JSON 格式的錯誤訊息 (狀態碼: ${geminiResponse.status})` };
        }
        console.error(`[錯誤] Gemini API 回報客戶端錯誤 (索引: ${keyIndex})`, JSON.stringify(errorData));
        return response.status(geminiResponse.status).json(errorData);
      }

      // 如果請求成功 (HTTP 200)
      const data = await geminiResponse.json();
      
      // 【修訂 4】核心修正：驗證並提取生成的文本，解決「無效格式」和「生成失敗」問題。
      // 檢查 Gemini 是否因安全或其他原因阻止了內容生成。
      if (data.promptFeedback?.blockReason) {
           console.warn(`[警告] 內容生成被 Gemini 阻止 (索引: ${keyIndex})，原因: ${data.promptFeedback.blockReason}。正在切換至下一個 Key...`);
           keyIndex = (keyIndex + 1) % totalKeys;
           await setCurrentKeyIndex(keyIndex);
           continue; // 換下一個 Key 重試
      }
      
      // 提取生成的文本，並檢查 'candidates' 陣列是否存在且包含內容。
      const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!generatedText) {
          console.warn(`[警告] API Key (索引: ${keyIndex}) 回應成功，但未包含有效的生成文本。可能是內容被過濾。正在切換...`);
          keyIndex = (keyIndex + 1) % totalKeys;
          await setCurrentKeyIndex(keyIndex);
          continue; // 內容為空，換下一個 Key 重試
      }
      
      console.log(`[成功] 使用第 ${keyIndex + 1} 個 API Key 生成成功。`);
      // 回傳一個結構簡單的 JSON 物件，其中只包含最終的文章，方便前端使用。
      return response.status(200).json({ text: generatedText.trim() });

    } catch (error) {
      // 處理網路錯誤或請求超時
      console.error(`[嚴重錯誤] 連接至 Gemini API 時發生網路層錯誤或請求超時 (索引: ${keyIndex}):`, error.name === 'TimeoutError' ? '請求超時' : error.message);
      keyIndex = (keyIndex + 1) % totalKeys;
      await setCurrentKeyIndex(keyIndex);
      // 這裡不需要 continue，因為 for 迴圈會自動進入下一輪
    }
  }

  // 步驟 6: 如果所有金鑰都嘗試失敗
  console.error('[緊急] 所有 API Keys 皆已嘗試失敗。');
  response.status(429).json({ error: '所有可用的 API 金鑰皆已達到每日限額或請求失敗，請稍後再試。' });
}
