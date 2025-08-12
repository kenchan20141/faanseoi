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

// 將範文和 Prompt 生成邏輯移至後端
const SAMPLE_ESSAYS = `
[作文範例參考]

請參考以下三篇優秀作文的風格和技巧：

第一篇：《煙火》
回鄉的我凝望著門前的「河流」，沉默不語。那場璀璨的煙火又在我杳遠的回憶隱然綻放。
我記得，故鄉梁莊的那夜是樸素的，是低調的，就像默默俯身收割莊稼的農民；我記得，那時祖屋的遠處種著桑樹，樹上迴響著清亮的蟬聲，而近處蜿蜒著一道河，河畔的蘆葦總傳來蛙鳴；那是元旦，鄰居李叔親切地送上祝福，又從吳鎮的煙火廠帶來了龍吐珠，與村民慶賀新春。煙花在夜幕訇然盛放之時，七歲的我正環抱著爺爺的頸項。所有的澄黃、亮綠和緋紅倏爾煥爛在我的眼眸。火光乍現，煙花便瞬即璀璨而華麗地枯萎了，只賸下硝煙和火藥的氣息。
我哭了，爺爺以為我被煙火嚇壞了，瞬即摩娑著我的背。
其實，我不過是驚詫於一切美好的幻滅。
後來，我才瞭解人生有許多事情都注定是一場美好的幻滅，如同煙火。
爺爺是我的留守歲月最璀璨的印記。我從村校放學回家時，爺爺總會捧著熱氣騰騰的、白花花的饅頭迎接著我。阿念，吃吧，快點吃吧。爺爺沙啞的聲線仍猶在耳。童年的我總喜歡伏在爺爺的背上諦聽著時間，一秒，兩秒，是多麼沉穩的幸福呢。背並不厚實，但卻溫暖和煦。時間仿佛會一直定格在這一幀。然而在我九歲那年，爺爺死了，就淹死在門前的河。建築公司在河底挖沙蓋樓，河道看來平靜，卻暗藏漩渦。爺爺游泳時被暗湧拉扯到河底，就活活淹死了。短短數年的歲月，在人生裡不過是一場倉卒燃燒的煙火，爺爺在我的回憶裡綻放過澄黃、亮綠和緋紅，卻連一縷硝煙都沒有遺下，只遺下了一件濡濕的、皺巴巴的汗衣，儼如因衰老而再無能為力綻放的煙花。
還有門前的河流，在爺爺死後十年，已經沉默得如患上了失語症，河水乾涸，河床裸露，像被歲月無情強暴了一樣。夏蟬和青蛙，都憂鬱得噤聲不語，遷徙到回憶之外。李叔前年在電鍍廠中毒過身了。童年時一切一切的美好，都如海市蜃樓般驟然無存。歲月燃點了一場煙花，最後只遺下沉重的回憶，以及沉重地回憶的我。煙火再璀璨，也是匆促的。
本來我是這樣認為的。
直至又再離鄉之際，我才赫然窺探到煙火的秘密。
村口的大樹懸掛著纍纍碩大的林柿，那一個個橘橙的果實每年都爛在樹上，沒有村民採摘，連雀鳥都不屑一顧。在我準備踏出村口時，一顆飽滿的柿子掉落到我面前。我啃咬了一口，還是一如回憶的苦澀、難吃，我急不及待將咀嚼中的柿肉吐出來，且棄之如敝屣。我倏爾發現，縱然梁莊物換星移已不知幾度秋，但仍有許多回憶的遺跡，比如是眼前這棵金玉其外的柿樹。它的果實仍然是澀的，我想，是因為它仍然鮮活、茂盛、強壯，是因為它仍未枯謝、凋零、衰敝。假如它成為了歲月匆促幻滅的過客，也許那味道會是甘甜的苦澀，也許我會懷念那苦澀。
我再次凝望著那乾涸的河道。曩昔我嫌棄過蟬囀蛙鳴聒耳，擾人清夢；我埋怨過蘆葦纖長，阻礙了我的視野；我拒絕過爺爺的饅頭，因為寡淡無味，因為我想吃肉香滿溢的五香肘子啊，不想吃寡淡的、慘白的饅頭。我討厭過李叔蠟黃的臉色，討厭過他衣衫襤褸，討厭過他渾身汗臭，我討厭過李叔的一切。諷刺的是，隨著物和事匆促的面目全非，我竟爾留戀上一切我討厭過的。
於是我開始明白煙花的璀璨，在於它的匆促和幻滅。
時間會過濾掉所有人和事的雜質，隨著泯滅變易，我們開始犯賤地珍惜，然而珍惜的唯一意義僅在於遺憾，但正因為遺憾，才體現到事物的璀璨。倘若爺爺和李叔仍然在世，倘若門前的河仍然流淌不斷，倘若蟬聲蛙鳴依舊，倘若絢爛永恆，那麼一切便將腐爛而不再璀璨，他們和它們都將蛻變成被棄如敝屣的柿子。我曾以為煙火再璀璨，也是匆促的。但原來我錯了。原來煙火璀璨，正因為匆促。一旦煙火永恆，它將失去生命，教人徒然目眩。
離鄉的這夜，恰巧是元旦。是夜天陰，無雨。梁莊寂寥如一場夢，再沒有盛放的煙火。因為，煙花從此只在我的回憶裡燦爛地綻開、匆促地結果。

第二篇：《根》
火焰燃起了一瓣又一瓣的灰燼，它們即生即滅，像飄萍，是一種無根的存在。餘燼隨風零落，又再揚起，終落入了深邃的虛無裡。人們說，紙錢燒成灰燼，便會飛落到地獄，交到亡靈的手裡。
父親，你收到了嗎？
你，尋到你的根了嗎？
我向着一枚貝殼問道。
我們的故鄉是一個江南小鎮，名曰周莊。明代江南首富沈萬三昔曾坐落此處發施號令，指點江山，各種契約、決斷和銀票都有這裡大進大出過，如今卻只賸下沈廳的空寂。鎮上到處都是貫穿南北的河道，就像永不乾涸的阡陌。周莊的河網養活了一代又一代的周莊人，從這裡出發，可借河道而東西南北，近至蘇杭，遠通東南亞。我的父親，只是貿易的一塊細小的零件——卑微的船夫，但他卻盤根錯節，支撐著整個家庭。
「爸，你甚麼時候回家？」
小時候，每當我牽扯著他的衣襬問他這道問題時，他總會帶著疲憊的莞爾，摩娑著我的腦殼說道：
「很快了，很快了。」
於是，一去便是三兩個月了。他在無垠的河川和滄渤航行了一輩子，曾為多少家庭送上過物資，又曾目睹過多少匆忙歸家的白鷗呢？然而，他自己卻成為了一個無根的人。他飄洋過海，仿佛只為回來時睡一覺昏沉的。無根的浪花，便是父親的象徵；一身的鹹腥，便是他半生的註腳。
他細碎又重複的夢囈被年幼的我記住了。
在漫長的夢裡，他是參天巨樹，偉岸的、繁茂的，扎根在風吹草低見牛羊的草原。風拂過他的臉龐，他貪婪地流了一行涎液。
一切都只為了養活我們四兄弟姐妹，成為這個家庭的根。母親呢，從不嚮往自由而無根的蒲公英，在我們孩提時代，她已經從周莊的河網掙脫出去了。只賸下父親，像根一樣默默無言地支撐著這個家庭的經濟，用河水澆灌，為它提供養份；用船櫓翻土，使它茁壯成長。我們幾兄弟姐妹，就恍如纍纍碩大的果實。果實之所以飽滿豐美，全因深扎泥土的根。
短暫洗去風塵後，又是一個擾人的昒暝。陽光揉開他的眼瞼，那沉重的眼瞼，一場無垠的旅程又將展開。
他成為了我們的根，自己呢，卻一直飄泊於風波不定的大海。我一直想，他的根究竟在哪裡呢？
也許，從來都不在印有郵遞編號的地方，而在我們。但早在十年前，都被我們砍斷了。終於，父親失去了他惟一的根。
長大後，我們不再牽扯父親的衣襬。父親在我們的印象，是一種昏睡的存在，我們之間存在著一種歲月孕育出來的隔閡——不冷淡又不溫韾的沉默。就像周莊的河水，既不溷濁，又不清澈。只有生活的氣息。隨著長大，我們一個又一個離開了日復如是的故鄉。他用一身風塵支撐的家，早在歲月的長河中淡褪了顏色。
被淹沒了。
大哥從來沒有帶過孩子回鄉。
二姐結婚時沒有邀請過父親。
妹妹幾年來音信杳無，聽說到加拿大去了。
只有我偶爾回鄉。父親總是無所事事，落寞地坐在斜曛映照的碼頭上，抽著雙喜牌香煙，眺望著那平靜如日子的河川。夕陽落在他身上，拓出了一個單薄的黑影。我這才知道，原來影子是會老，是會萎縮的。
他的身體開始坍塌，大不如曩日的壯碩，因為失去了根，失去了人生角色的緣故。他已經沒有了壯碩的理由。在病榻上，只有噏動的嘴唇透露著生命的跡象，在明滅不定的沉吟裡，我諦聽到我們的暱稱，又諦聽到那個關於樹的夢的碎片。不一樣的是，樹好像連根拔起了，似乎被一場颱風吹倒了。
我不會遺忘父親的好。每次他回周莊，他總會為我們帶來一枚貝殼，我愛把貝殼湊在耳畔聽那大海的聲音，有溫煦的，有舒爽的，有寂寞的，有思念的。他出航的畫面，總如真似幻地映照在我的腦海裡。但我無法將愛裸裎地宣之於口。父親，你飄泊半生，四海為家，卻終於失去了支撐你努力活著的角色。為了成為我們的根，你失去了自己的根。也許，也許你無法扎根在這個世界任何一隅，但我卻早為你預留了一捧最肥沃的泥土——在我心裡，讓你終於可以安息，終於可以落葉歸根，終於不用再飄泊不定。
海風永不止息地吹拂著一個夢，雲亦舒捲著無根的故事。

第三篇：《等待》
月亮高懸在闃寂的夜空，儼如吊著一顆無眠的眼睛。它仿佛記得，自己已用幾千年的時間等待一個人，但卻已遺忘了等待的對象。於是，它映照著下方喧囂的城市，映照著每一個在城市裡等待著的人。
比如說，一個在晚窗前許願的孩子，他在等待著綠豆的幼苗在濕潤的棉花裡茁壯成長，並開花結果。
又比如說，一個無聲吶喊著的女人。他的丈夫，那醉醺醺的男人，又在發瘋。一頓拳打腳踢之後，她身上青一片、紫一片的。原來人的皮膚可以呈現如此斑駁的顏色。然而，她已不驚詫，因為暴力早教她看見青紫色的自己。不過，她在等待，她依猶在等待，依猶在等待那個婚禮上替自己戴上婚戒的他。
想著想着，她無端落下了一滴淚。原來，許多人也在歲月的長河裡無止境地等待著。等待的人並不孤單。
一幀泛黃且充滿顆粒感的照片裡，一個小女孩正佻皮地捏著母親的臉頰，母親佯作生氣，她幸福地「生氣」著。
可愛吧？這個左邊的小女孩，便是我的女兒。
嗯，可愛。
同樣的對話，同樣的故事，在這八年的時光裡重重複複地敘述著。仿佛是一本八百頁的長篇小說，只有這樣的一段對話。但是，她仍樂此不疲地閱讀著小說的每一頁。因為，因為她已遺忘了上一頁的所有內容。
那個小女孩，便是我，而那位母親患了病，一場將我遺忘的病。
我一直等待著，等待著她有天重新憶記起我；等待著她像小時候一樣，摩娑著我的腦殼，溫柔地哄我入睡；等待著她生活裡每句使人心煩的嘮叨。我等待了八年，為此，我與她一起翻閱舊相冊，一起重遊所有老地方，然而奇蹟一直保持沉默，不作任何回應。在歲月的長河裡，只賺下佇立著、等候著的我。
女兒啊……
她又再躺在沙發上說著朦朦朧朧的囈語。
今晚煮了湯，放在客廳的……
「桌上」兩個音節裹未孵出來，便已胎死在掛掉的話裡了。那時的我，在過著燈紅酒綠的生活。月，仿佛才是昒暝的日出。一杯又一杯的長島冰茶灌進肚裡，根本容不下一碗溫熱的湯。
恰巧，也是八年的時間，媽媽也等待了八年的時間。她每一個晚上都在夢囈裡盼望著我歸家。然而等待一次又一次落空，只有蒼然寂寞的月色悄悄地透過窗戶，替她蓋上一張沒有溫度的被子。
八年後，我才真正明白等待的滋味，才體會到等待的煎熬。你是如何孤單地度過每一個昏暗的夜，如何忍受著一句句使你痛徹心扉的說話？一切的等待為了甚麼？
我的女兒回來了嗎？
你瞇著惺忪的睡眼問我。
還未，她還未回來，再等一下吧。
其實，她永遠都不會回來了，因為她已永恆地滯留在時光的隧道裡。在那個地方，夢即現實，回憶即現實，人永遠不會長大，更不會蒼老。因此之故，她永遠不會回來了。
至於我等待的人，等待的一聲呼喊，也不會回來了。她已羈困在一段停滯的時光裡，沒有逃逸，亦沒有人想逃逸。因為，她已等待得支離破碎，疲憊不堪了。
我們的等待，注定了落空。
但八年的等待裡，我終究參悟了落空的意義。正如那棵似乎會勃發生長的綠豆苗，也許一星期後便會似一場曉夢般枯萎，但孩子學會了生命的價值，學會了甚麼是失落，學會了憧憬在字典外的含義；又正如那個滿佈瘡痍的女人，在漫無邊際的等待裡，或許終於明白了有些等待並不值得，明白了有些等待並不值得，明白了有些等待只是一廂情願，於是鼓起離婚的勇氣。在等待裡，所有人都會找到新的意義。也許，等待只是一場燦爛奪目的煙花，只承諾開花，卻從不承諾結果。但在等待裡，我們都重新認識了自己和他人，甚或是人生。一如八年的等待，使我終於能體會媽媽的體會，孤寂、失望、無奈、感慨、悱惻，我都一一感受到了。她沒有遺下一句說話，便將我遺留在時光的彼岸，然而她內心最隱密的說話，我已諦聽到了。因為，我也成為了一個等待的人。等待的過程裡，我還學會了堅強、勇氣和耐心。從前，我何曾耐心地回應過她一句呢？
等著等著，她便像個孩子似的，哭嚷著要女兒回來，我溫柔地摩娑著她的髮絲、她的臉龐、她的下巴、她的背、她的手，又在她耳畔低語：「別怕，我與你一起等女兒回來，好不好？」她冷靜下來，默默地頷著首。
煙花，終於結了果，一如等待，終於在落空中結了果。
`;

function getSystemPrompt(structure, wordCount, topic, guidelines) {
    let coreInstruction;
    if (structure === 'classic') {
        coreInstruction = `幫我創作一篇${wordCount}字 文學性高的DSE敘事散文，題目為「${topic}」。`;
    } else { // threeline
        coreInstruction = `幫我創作一篇${wordCount}字 文學性高的DSE敘事散文，要用三線散敘寫作，題目為「${topic}」。`;
    }

    if (guidelines) {
        coreInstruction += `\n\n[創作指引]\n${guidelines}`;
    }

    return `
[最終指令]
${coreInstruction}
請嚴格模仿並參考以下範文的風格、深度和技巧進行創作。
最終輸出必須為一篇完整的純文字文章。絕不允許使用任何Markdown格式（如標題符號 #、粗體 **、列表 - * 等）。
絕不允許在文章前後或內部包含任何思考過程、解釋、標籤或非文章內容的文字。直接開始寫作即可。

${SAMPLE_ESSAYS}
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
  const MODEL_NAME = 'gemini-2.5-pro'; // 建議使用最新模型
  const systemPrompt = getSystemPrompt(structure, wordCount, topic, guidelines);
  
  const requestBody = {
    "contents": [{ "role": "user", "parts": [{ "text": systemPrompt }] }],
    "generationConfig": {
        "temperature": 1,
        "topP": 0.9,
        "maxOutputTokens": 4096
    }
  };

  // 步驟 5: 核心邏輯 - 迴圈嘗試所有金鑰，直到成功或全部失敗
  for (let i = 0; i < totalKeys; i++) {
    const currentKey = apiKeys[keyIndex];
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${currentKey}`;

    try {
      console.log(`[資訊] 正在嘗試使用第 ${keyIndex + 1} 個 API Key (索引: ${keyIndex})`);

      const geminiResponse = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(45000) // 45秒超時
      });

      // 如果請求成功 (HTTP 200)
      if (geminiResponse.ok) {
        const data = await geminiResponse.json();
        
        // 再次檢查 Gemini 是否因安全理由阻止了內容生成
        if (data.promptFeedback?.blockReason) {
             console.warn(`[警告] 內容生成被 Gemini 阻止 (索引: ${keyIndex})，原因: ${data.promptFeedback.blockReason}。正在切換至下一個 Key...`);
             keyIndex = (keyIndex + 1) % totalKeys;
             await setCurrentKeyIndex(keyIndex); // 更新索引
             continue; // 用下一個 Key 重試
        }
        
        console.log(`[成功] 使用第 ${keyIndex + 1} 個 API Key 生成成功。`);
        return response.status(200).json(data);
      }
      
      // 如果額度用盡 (HTTP 429)
      if (geminiResponse.status === 429) {
        console.warn(`[警告] 第 ${keyIndex + 1} 個 API Key 已達額度上限。正在切換至下一個...`);
        keyIndex = (keyIndex + 1) % totalKeys;
        await setCurrentKeyIndex(keyIndex); // 更新索引並重試
        continue; 
      }
      
      // 其他 API 錯誤 (如 400 請求錯誤, 500 伺服器錯誤)
      const errorData = await geminiResponse.json();
      console.error(`[錯誤] Gemini API 回報錯誤 (狀態碼: ${geminiResponse.status})，金鑰索引: ${keyIndex}。錯誤內容:`, JSON.stringify(errorData));
      
      // 如果是伺服器端錯誤，也值得換 Key 重試
      if (geminiResponse.status >= 500) {
        console.warn(`[警告] Gemini 遭遇伺服器錯誤，嘗試切換 Key...`);
        keyIndex = (keyIndex + 1) % totalKeys;
        await setCurrentKeyIndex(keyIndex);
        continue;
      }

      // 如果是 4xx 客戶端錯誤 (非 429)，通常表示請求本身有問題，直接回傳錯誤
      return response.status(geminiResponse.status).json(errorData);

    } catch (error) {
      console.error(`[嚴重錯誤] 連接至 Gemini API 時發生網路層錯誤或請求超時 (索引: ${keyIndex}):`, error);
      keyIndex = (keyIndex + 1) % totalKeys;
      await setCurrentKeyIndex(keyIndex);
    }
  }

  // 步驟 6: 如果所有金鑰都嘗試失敗
  console.error('[緊急] 所有 API Keys 皆已嘗試失敗。');
  response.status(429).json({ error: '所有可用的 API 金鑰皆已達到每日限額或請求失敗，請稍後再試。' });
}
