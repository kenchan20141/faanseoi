// ========================================================================
//  Gemini 作文生成 API - 金鑰輪換代理 (2025) - 修訂版
//  功能:
//  1. 接收前端傳來的作文題目、字數、指引等參數。
//  2. 從 Vercel 環境變數讀取所有 Gemini API Keys。
//  3. 使用 Vercel KV (Upstash Redis) 讀寫當前金鑰的索引。
//  4. 如果 API Key 額度用盡 (HTTP 429)，自動切換至下一個並重試。
//  5. 構造完整的 Prompt，呼叫 Gemini API。
//  6.【修訂】明確解析 API 回應，只將生成的純文字作文回傳給前端。
//  7.【修訂】強化錯誤處理，確保任何情況下都回傳合法的 JSON。
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
      cache: 'no-store', // 確保每次都從伺服器獲取最新值
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
      headers: { 
        'Authorization': `Bearer ${KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
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
    return response.status(405).json({ error: '僅允許 POST 請求。' });
  }

  try {
    // 從請求中提取參數
    const { topic, wordCount, guidelines, structure } = request.body;
    if (!topic || !wordCount || !structure) {
      return response.status(400).json({ error: '請求中缺少必要參數 (topic, wordCount, structure)。' });
    }

    // 步驟 2: 從環境變數讀取所有 API Keys
    const apiKeysString = process.env.GEMINI_API_KEYS;
    if (!apiKeysString || !KV_REST_API_URL || !KV_REST_API_TOKEN) {
      const errorMessage = '伺服器端未設定 API Keys 或未連接 KV 數據庫。';
      console.error(errorMessage);
      return response.status(500).json({ error: errorMessage });
    }
    const apiKeys = apiKeysString.split(',').map(key => key.trim()).filter(Boolean);
    const totalKeys = apiKeys.length;
    
    if (totalKeys === 0) {
        return response.status(500).json({ error: '環境變數中未找到有效的 API Keys。' });
    }

    // 步驟 3: 從 KV 數據庫獲取當前應使用的金鑰索引
    let keyIndex = await getCurrentKeyIndex();

    // 步驟 4: 準備發送給 Gemini API 的請求內容
    const MODEL_NAME = 'gemini-2.5-pro'; // 建議使用最新穩定模型
    const systemPrompt = getSystemPrompt(structure, wordCount, topic, guidelines);
    
    const requestBody = {
      "contents": [{ "role": "user", "parts": [{ "text": systemPrompt }] }],
      "generationConfig": {
          "temperature": 1,
          "topP": 0.95,
          "maxOutputTokens": 8192,
      },
      "safetySettings": [ // 適度放寬安全設定，避免因誤判而阻止生成
        { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE" },
        { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_MEDIUM_AND_ABOVE" },
        { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_MEDIUM_AND_ABOVE" },
        { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE" }
      ]
    };

    // 步驟 5: 核心邏輯 - 迴圈嘗試所有金鑰，直到成功或全部失敗
    for (let i = 0; i < totalKeys; i++) {
      const currentKey = apiKeys[keyIndex];
      const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${currentKey}`;
      let attemptError = null;

      try {
        console.log(`[資訊] 正在嘗試使用第 ${keyIndex + 1}/${totalKeys} 個 API Key (索引: ${keyIndex})`);

        const geminiResponse = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(300000) // 60秒超時
        });
        
        // 嘗試解析 Gemini 的回傳，無論狀態碼為何
        const responseText = await geminiResponse.text();
        const data = JSON.parse(responseText);

        // 如果請求成功 (HTTP 200)
        if (geminiResponse.ok) {
          // 再次檢查 Gemini 是否因安全理由阻止了內容生成
          if (data.promptFeedback?.blockReason) {
               const reason = data.promptFeedback.blockReason;
               console.warn(`[警告] 內容生成被 Gemini 阻止 (索引: ${keyIndex})，原因: ${reason}。正在切換至下一個 Key...`);
               attemptError = `內容生成被 Gemini 阻止 (原因: ${reason})。`;
          } else {
              // 【修訂】從巢狀結構中提取作文文字
              const essayText = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (essayText) {
                console.log(`[成功] 使用第 ${keyIndex + 1} 個 API Key 生成成功。`);
                // 【修訂】回傳固定格式的 JSON
                return response.status(200).json({ essay: essayText });
              } else {
                // 雖然 HTTP 200，但沒有有效的內容
                console.warn(`[警告] API 回應成功但找不到生成的內容 (索引: ${keyIndex})。回應:`, responseText);
                attemptError = 'API 回應成功但找不到生成的內容。';
              }
          }
        } else if (geminiResponse.status === 429) { // 如果額度用盡 (HTTP 429)
          console.warn(`[警告] 第 ${keyIndex + 1} 個 API Key 已達額度上限。正在切換至下一個...`);
          attemptError = 'API Key 已達額度上限。';
        } else { // 其他 API 錯誤
          console.error(`[錯誤] Gemini API 回報錯誤 (狀態碼: ${geminiResponse.status})，金鑰索引: ${keyIndex}。錯誤內容:`, responseText);
          attemptError = `Gemini API 錯誤 (狀態碼 ${geminiResponse.status})。`;
        }
      } catch (error) {
        if (error.name === 'AbortError') {
             console.error(`[嚴重錯誤] 連接至 Gemini API 時請求超時 (索引: ${keyIndex})`);
             attemptError = '請求超時。';
        } else if (error instanceof SyntaxError) {
             console.error(`[嚴重錯誤] 解析 Gemini API 回應時發生 JSON 錯誤 (索引: ${keyIndex})，收到的不是有效的 JSON。`);
             attemptError = '解析 API 回應失敗，可能 API 服務異常。';
        } else {
             console.error(`[嚴重錯誤] 連接至 Gemini API 時發生網路層錯誤 (索引: ${keyIndex}):`, error);
             attemptError = '網路連線錯誤。';
        }
      }
      
      // 如果當前 Key 失敗，切換到下一個並更新 KV
      keyIndex = (keyIndex + 1) % totalKeys;
      await setCurrentKeyIndex(keyIndex);
      
      // 如果這是最後一個 key，且仍然失敗，則跳出迴圈
      if (i === totalKeys - 1) {
          console.error(`[緊急] 所有 ${totalKeys} 個 API Keys 皆已嘗試失敗。最後一次錯誤: ${attemptError}`);
          return response.status(429).json({ error: '所有可用的 API 金鑰皆已達到每日限額或請求失敗，請稍後再試。' });
      }
    }
  } catch (e) {
    // 捕捉最外層的未知錯誤，確保伺服器不會崩潰並能回傳格式正確的錯誤訊息
    console.error('[伺服器內部未知錯誤]', e);
    return response.status(500).json({ error: '伺服器發生未預期的內部錯誤。' });
  }
}
