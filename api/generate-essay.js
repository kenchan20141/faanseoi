// ========================================================================
//  Gemini 作文生成 API - 金鑰輪換代理 (2025) - 修訂版
//  修訂重點:
//  1. [關鍵] 在收到 Gemini 的 200 OK 回應後，增加了一層驗證，確保 `candidates` 陣列中包含有效的文字內容。
//  2. 如果 200 OK 回應中沒有有效內容，會將其視為失敗，並自動嘗試下一個 API Key。
//  3. 伺服器不再回傳整個 Gemini API 的複雜物件，而是回傳一個簡潔的 `{ "essay": "..." }` 物件，簡化了前端的處理邏輯。
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

const hiddenGuideline = "另外，必須避免使用陳腔濫調的情節（例如車禍、絕症、夢境結局），請構思更具原創性、更貼近真實人性的情節轉折。";
  
    let coreInstruction;
    if (structure === 'classic') {
        coreInstruction = `你是一位文學散文大師，你的任務是要創作情感真摯、立意深刻、句式自然的作品。作品必須在${wordCount}字內，文學性高、過渡自然（不可以用時間詞過渡，例如「三年後」、「小時候」、「如今」，要多變）、意象豐富的敘事散文，情節不可零散，一件事要慢慢渲染，延續寫下去，刻劃人物及情節都要求質不求量，才會動人。要重視人物之間的感情和交流，有不同的事件及回憶相互映襯突出主題，要善用通感及融情入景。必須避免使用身體部位作主語，例如「指尖」、「額角」。人物的對話不能有說教意味，要更有人情、人性。題材要特別點，角色不能死或病。題目為「${topic}」。`;
    } else { // threeline
        coreInstruction = `你是一位文學散文大師。你的任務是要創作情感真摯、立意深刻的作品、句式自然的作品。作品必須在${wordCount}字內，文學性高、過渡自然（不可以用時間詞過渡，例如「三年後」、「小時候」、「如今」，要多變）、意象豐富的敘事散文，情節不可零散，一件事要慢慢渲染，延續寫下去，刻劃人物及情節都要求質不求量，才會動人。要重視人物之間的感情和交流，有不同的事件及回憶相互映襯突出主題，要善用通感及融情入景。必須避免使用身體部位作主語，例如「指尖」、「額角」。人物的對話不能有說教意味，要更有人情、人性。題材要特別點，角色不能死或病。要用三線散敘寫作，題目為「${topic}」。`;
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
    return response.status(405).json({ error: 'Method Not Allowed' });
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
  const apiKeys = apiKeysString.split(',').map(key => key.trim()).filter(key => key);
  const totalKeys = apiKeys.length;

  if (totalKeys === 0) {
    const errorMessage = '伺服器端設定了 GEMINI_API_KEYS，但其中沒有有效的金鑰。';
    console.error(errorMessage);
    return response.status(500).json({ error: errorMessage });
  }

  // 步驟 3: 從 KV 數據庫獲取當前應使用的金鑰索引
  let keyIndex = await getCurrentKeyIndex();

  // 步驟 4: 準備發送給 Gemini API 的請求內容
  const MODEL_NAME = 'gemini-2.5-pro'; // 維持不變
  const systemPrompt = getSystemPrompt(structure, wordCount, topic, guidelines);
  
  const requestBody = {
    "contents": [{ "role": "user", "parts": [{ "text": systemPrompt }] }],
    "generationConfig": {
        "temperature": 1,
        "topP": 0.9,
        "maxOutputTokens": 10000 // 維持不變
    }
  };

  // 步驟 5: 核心邏輯 - 迴圈嘗試所有金鑰，直到成功或全部失敗
  for (let i = 0; i < totalKeys; i++) {
    const currentKey = apiKeys[keyIndex];
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${currentKey}`;

    try {
      console.log(`[資訊] 正在嘗試使用第 ${keyIndex + 1}/${totalKeys} 個 API Key (索引: ${keyIndex})`);

      const geminiResponse = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(300000) // 300秒超時, 維持不變
      });
      
      // 如果請求成功 (HTTP 200)，需要進一步驗證內容
      if (geminiResponse.ok) {
        const data = await geminiResponse.json();
        
        // 【關鍵修訂】從回應中安全地提取文字
        const generatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        // 【關鍵修訂】檢查是否有因為安全設定等原因被阻擋
        if (data.promptFeedback?.blockReason) {
             console.warn(`[警告] 內容生成被 Gemini 阻止 (索引: ${keyIndex})，原因: ${data.promptFeedback.blockReason}。正在切換至下一個 Key...`);
             keyIndex = (keyIndex + 1) % totalKeys;
             await setCurrentKeyIndex(keyIndex);
             continue; // 用下一個 Key 重試
        }
        
        // 【關鍵修訂】如果成功但文字內容為空，也視為失敗並重試
        if (generatedText && generatedText.trim().length > 0) {
            console.log(`[成功] 使用第 ${keyIndex + 1} 個 API Key 生成成功。`);
            // 【關鍵修訂】只回傳乾淨的文章，而不是整個 Gemini 物件
            return response.status(200).json({ essay: generatedText.trim() });
        } else {
            console.warn(`[警告] API 回應成功 (200 OK) 但未包含有效內容 (索引: ${keyIndex})。可能觸發了安全過濾但未明確標示。正在切換至下一個 Key...`);
            keyIndex = (keyIndex + 1) % totalKeys;
            await setCurrentKeyIndex(keyIndex);
            continue; // 內容為空，換下一個 Key 重試
        }
      }
      
      // 如果額度用盡 (HTTP 429)
      if (geminiResponse.status === 429) {
        console.warn(`[警告] 第 ${keyIndex + 1} 個 API Key 已達額度上限。正在切換至下一個...`);
        keyIndex = (keyIndex + 1) % totalKeys;
        await setCurrentKeyIndex(keyIndex);
        continue; // 到達限額，換下一個 Key 重試
      }
      
      // 其他 API 錯誤 (如 400 請求錯誤, 500 伺服器錯誤)
      const errorData = await geminiResponse.json().catch(() => ({ error: { message: `API回傳了狀態 ${geminiResponse.status} 但回應內文不是有效的JSON。` }}));
      console.error(`[錯誤] Gemini API 回報錯誤 (狀態碼: ${geminiResponse.status})，金鑰索引: ${keyIndex}。錯誤內容:`, JSON.stringify(errorData));
      
      // 如果是伺服器端錯誤，值得換 Key 重試
      if (geminiResponse.status >= 500) {
        console.warn(`[警告] Gemini 遭遇伺服器錯誤，嘗試切換 Key...`);
        keyIndex = (keyIndex + 1) % totalKeys;
        await setCurrentKeyIndex(keyIndex);
        continue;
      }

      // 如果是 4xx 客戶端錯誤 (非 429)，通常表示請求本身有問題，直接回傳錯誤
      return response.status(geminiResponse.status).json({ error: errorData?.error?.message || 'Gemini API 回報客戶端錯誤。' });

    } catch (error) {
       if (error.name === 'TimeoutError') {
            console.error(`[嚴重錯誤] 請求超時 (300秒)，正在切換至下一個Key... (索引: ${keyIndex})`);
        } else {
            console.error(`[嚴重錯誤] 連接至 Gemini API 時發生網路層錯誤 (索引: ${keyIndex}):`, error.message);
        }
        keyIndex = (keyIndex + 1) % totalKeys;
        await setCurrentKeyIndex(keyIndex);
    }
  }

  // 步驟 6: 如果所有金鑰都嘗試失敗
  console.error('[緊急] 所有 API Keys 皆已嘗試失敗。');
  response.status(503).json({ error: '所有可用的 API 資源均暫時無法處理您的請求，請稍後再試。' });
}
