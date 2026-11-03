// ==============================================================================
// CONFIGURATION - REPLACE WITH YOUR KEYS
// ==============================================================================
const TELEGRAM_BOT_TOKEN = "YOUR_BOT_TOKEN";
const OPENAI_API_KEY = "YOUR_API_KEY";
const WEBAPP_URL = "YOUR_WEBAPP_URL";
const SPREADSHEET_ID = "YOUR_SHEET_ID";

// Security: pick your own random string. Apps Script web apps can't read HTTP
// headers, so Telegram's header-based secret_token can't be checked here —
// this is appended as a URL query param on the webhook instead (see
// setTelegramWebhook) and validated in doPost so random POSTs to WEBAPP_URL
// can't mutate your sheet.
const WEBHOOK_SECRET = "RANDOM_STRING";

// Only these Telegram chat IDs may use the bot / receive the daily summary.
// Find your own chat_id by messaging the bot once, then checking Logger.log
// (Executions tab) or https://api.telegram.org/bot<token>/getUpdates.
const ALLOWED_CHAT_IDS = ["YOUR_CHAT_ID"]; // strings, e.g. ["123456789"]

// Sheet Tab Names
const DASHBOARD_TAB = "DASHBOARD_SHEET_NAME";
const TRACKER_TAB = "TRACKER_SHEET_NAME";

const MCC_API_URL = "YOUR_MCC_CHECKER_SERVICE_URL";

// ==============================================================================
// 1. MAIN TELEGRAM WEBHOOK HANDLER
// ==============================================================================
function doPost(e) {
  try {
    // Reject anything without the shared secret so random POSTs to WEBAPP_URL
    // can't append/delete/reclassify rows. Set via setTelegramWebhook().
    const suppliedSecret = e.parameter && e.parameter.secret;
    if (suppliedSecret !== WEBHOOK_SECRET) {
      Logger.log("Rejected webhook call: bad or missing secret");
      return HtmlService.createHtmlOutput("OK");
    }

    const data = JSON.parse(e.postData.contents);

    // Handle interactive button taps
    if (data.callback_query) {
      const cqChatId = data.callback_query.message.chat.id.toString();
      if (ALLOWED_CHAT_IDS.indexOf(cqChatId) === -1) {
        Logger.log("Rejected callback_query from unauthorized chat: " + cqChatId);
        return HtmlService.createHtmlOutput("OK");
      }
      handleCallbackQuery(data.callback_query);
      return HtmlService.createHtmlOutput("OK");
    }

    if (!data.message) return HtmlService.createHtmlOutput("OK");

    const message = data.message;
    const chatId = message.chat.id;

    if (ALLOWED_CHAT_IDS.indexOf(chatId.toString()) === -1) {
      Logger.log("Rejected message from unauthorized chat: " + chatId);
      return HtmlService.createHtmlOutput("OK");
    }

    let textPrompt = message.text || message.caption || "";
    let base64Image = null;
    let mimeType = "image/jpeg";

    // Handle /start command
    if (textPrompt.trim().toLowerCase() === "/start") {
      const welcomeMsg = `👋 *Wah, spending again?*\n\n` +
                         `Welcome to *Kiap Moolah*! I'm here to make sure your budget doesn't magically disappear.\n\n` +
                         `👇 *How to log an expense:*\n` +
                         `1️⃣ *Text me:* "Kopi $1.50"\n` +
                         `2️⃣ *Snap a pic:* Send any PayNow or bank screenshot.\n\n` +
                         `I'll do the math and let you know your daily quota. Try sending your first expense now!`;
      sendTelegramMessage(chatId, welcomeMsg);
      return HtmlService.createHtmlOutput("OK");
    }

    if (message.photo) {
      // message.photo is ordered smallest -> largest. Skip the largest size;
      // one step down is still plenty legible for OCR and cheaper to transfer.
      const photoArray = message.photo;
      const fileId = photoArray[Math.max(0, photoArray.length - 2)].file_id;

      const fileRes = UrlFetchApp.fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
        { muteHttpExceptions: true }
      );
      const fileJson = JSON.parse(fileRes.getContentText());

      if (!fileJson.ok) {
        Logger.log("Telegram getFile failed: " + fileRes.getContentText());
        sendTelegramMessage(chatId, "⚠️ Couldn't download that photo. Please try sending it again.");
        return HtmlService.createHtmlOutput("OK");
      }

      const imgRes = UrlFetchApp.fetch(
        `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileJson.result.file_path}`,
        { muteHttpExceptions: true }
      );
      if (imgRes.getResponseCode() !== 200) {
        Logger.log("Telegram file download failed: " + imgRes.getResponseCode());
        sendTelegramMessage(chatId, "⚠️ Couldn't download that photo. Please try sending it again.");
        return HtmlService.createHtmlOutput("OK");
      }

      base64Image = Utilities.base64Encode(imgRes.getContent());
      // Telegram always serves photos as JPEG, but its file server reports
      // application/octet-stream, which OpenAI rejects. Hardcode the real type.
      mimeType = "image/jpeg";
    }

    if (!textPrompt && !base64Image) {
      sendTelegramMessage(chatId, "⚠️ Please send a text expense or a PayNow screenshot.");
      return HtmlService.createHtmlOutput("OK");
    }

    // Call OpenAI API to classify expense
    let parsed;
    try {
      parsed = parseExpenseWithOpenAI(textPrompt, base64Image, mimeType);
    } catch (apiErr) {
      Logger.log("OpenAI call failed: " + apiErr.toString());
      sendTelegramMessage(chatId, "⚠️ Expense parser is temporarily unavailable. Please try again shortly.");
      return HtmlService.createHtmlOutput("OK");
    }

    if (!parsed || typeof parsed.amount !== "number" || !parsed.subcategory) {
      Logger.log("Unparseable OpenAI result: " + JSON.stringify(parsed));
      sendTelegramMessage(chatId, "⚠️ Couldn't parse expense details. Please try again.");
      return HtmlService.createHtmlOutput("OK");
    }

    // Lock around append+read-last-row so two near-simultaneous messages
    // can't interleave and hand out the same/wrong row number to their
    // Confirm/Reclass/Delete buttons.
    const lock = LockService.getScriptLock();
    let rowNumber;
    try {
      lock.waitLock(10000);
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      const trackerSheet = ss.getSheetByName(TRACKER_TAB);
      const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

      trackerSheet.appendRow([todayStr, parsed.subcategory, parsed.amount, parsed.description, "Telegram Bot"]);
      SpreadsheetApp.flush();
      rowNumber = trackerSheet.getLastRow();
    } catch (lockErr) {
      Logger.log("Sheet write failed: " + lockErr.toString());
      sendTelegramMessage(chatId, "⚠️ Couldn't save that expense. Please try again.");
      return HtmlService.createHtmlOutput("OK");
    } finally {
      lock.releaseLock();
    }

    const replyMsg = buildLoggedMessage("✅ *Logged Expense!*", parsed.description, parsed.subcategory, parsed.amount, parsed.merchant, "");
    sendTelegramWithButtons(chatId, replyMsg, rowNumber);

  } catch (err) {
    Logger.log("Error in doPost: " + err.toString() + "\n" + (err.stack || ""));
  }
  return HtmlService.createHtmlOutput("OK");
}

// ==============================================================================
// 2. BUTTON CALLBACK PROCESSOR (CHECK MCC, CONFIRM, RECLASS, DELETE)
// ==============================================================================
function handleCallbackQuery(callback) {
  const callbackId = callback.id;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const actionData = callback.data;

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const trackerSheet = ss.getSheetByName(TRACKER_TAB);

  // 1. User taps "Confirm"
  if (actionData.startsWith("confirm_")) {
    answerCallbackQuery(callbackId, "✅ Locked & Confirmed!");
    removeInlineKeyboard(chatId, messageId);
    return;
  }

  answerCallbackQuery(callbackId);

  // 2. User taps "Check MCC" -> look up, show result, keep the other buttons
  if (actionData.startsWith("mcc_")) {
    const rowNum = parseInt(actionData.split("_")[1]);
    if (rowNum > 1 && rowNum <= trackerSheet.getLastRow()) {
      const subcat = trackerSheet.getRange(rowNum, 2).getValue();
      const amount = parseFloat(trackerSheet.getRange(rowNum, 3).getValue());
      const desc = trackerSheet.getRange(rowNum, 4).getValue();

      const msgText = callback.message.text || "";
      const merchant = extractField(msgText, "Merchant");
      const mccText = formatMccResults(lookupMcc(merchant || desc));

      const updatedMsg = buildLoggedMessage("✅ *Logged Expense!*", desc, subcat, amount, merchant, mccText);
      editTelegramMessage(chatId, messageId, updatedMsg, buildKeyboard(rowNum, false));
    }
    return;
  }

  // 3. User taps a Category to Reclassify
  if (actionData.startsWith("reclass_")) {
    const firstUnderscore = actionData.indexOf("_");
    const secondUnderscore = actionData.indexOf("_", firstUnderscore + 1);
    const rowNum = parseInt(actionData.substring(firstUnderscore + 1, secondUnderscore));
    const newSubcat = actionData.substring(secondUnderscore + 1);

    if (rowNum > 1 && rowNum <= trackerSheet.getLastRow()) {
      trackerSheet.getRange(rowNum, 2).setValue(newSubcat);
      SpreadsheetApp.flush();

      const itemDesc = trackerSheet.getRange(rowNum, 4).getValue();
      const amount = parseFloat(trackerSheet.getRange(rowNum, 3).getValue());

      // Carry over merchant / MCC lines if they were already on the message
      const msgText = callback.message.text || "";
      const merchant = extractField(msgText, "Merchant");
      const mccText = extractField(msgText, "MCC");

      const updatedMsg = buildLoggedMessage("✏️ *Reclassified & Locked!*", itemDesc, newSubcat, amount, merchant, mccText);
      editTelegramMessage(chatId, messageId, updatedMsg);
      // Lock the message after reclassify so stale row-number buttons
      // (which go wrong once a delete shifts rows) can't be tapped again.
      removeInlineKeyboard(chatId, messageId);
    }
  }

  // 4. User taps "Delete / Undo"
  else if (actionData.startsWith("delete_")) {
    const rowNum = parseInt(actionData.split("_")[1]);

    if (rowNum > 1 && rowNum <= trackerSheet.getLastRow()) {
      const itemDesc = trackerSheet.getRange(rowNum, 4).getValue();
      const amount = trackerSheet.getRange(rowNum, 3).getValue();

      trackerSheet.deleteRow(rowNum);
      SpreadsheetApp.flush();

      editTelegramMessage(chatId, messageId, `🗑️ *Deleted!* Removed *$${amount}* (${escapeMd(itemDesc)}) from your tracker.`);
      // Rows below this one just shifted up by one, so this message's own
      // buttons (and any other still-live message pointing at a row below
      // rowNum) would now target the wrong expense. Lock this message;
      // there's no cheap way to fix the other messages without a stable
      // per-row ID, so avoid deleting/reclassifying out of order where possible.
      removeInlineKeyboard(chatId, messageId);
    }
  }
}

// ==============================================================================
// 3. OPENAI MULTIMODAL PARSER (GPT-4o-mini)
// ==============================================================================
function parseExpenseWithOpenAI(textPrompt, base64Image, mimeType) {
  const url = "https://api.openai.com/v1/chat/completions";

  const systemInstruction = `You are a financial bot for a user in Singapore.
Extract transaction details and classify into EXACTLY ONE of these specific subcategories based on intent:
1. "Variable Monthly Needs" (Day-to-day essentials, food, transport, groceries)
2. "Variable Investments" (Ad-hoc stocks, crypto, extra savings)
3. "Variable Monthly Wants" (Shopping, gadgets, entertainment, luxury)

Return strictly JSON with this exact schema:
{
  "subcategory": "Variable Monthly Needs" | "Variable Investments" | "Variable Monthly Wants",
  "amount": <number>,
  "description": "<short exact description of purchase>",
  "merchant": "<store/merchant name only, without the item, e.g. 'Marks & Spencer' or 'Cold Storage'; empty string if none is identifiable>"
}`;

  const userContent = [];

  if (textPrompt) {
    userContent.push({ type: "text", text: `User Input: ${textPrompt}` });
  } else {
    userContent.push({ type: "text", text: "Extract transaction details from this image." });
  }

  if (base64Image) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${mimeType};base64,${base64Image}`,
        // "low" fixes token cost regardless of source resolution (no tiling).
        // Bump to "high" only if receipt text is small enough to misread at low detail.
        detail: "low"
      }
    });
  }

  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: userContent }
    ],
    response_format: { type: "json_object" },
    temperature: 0.1
  };

  const options = {
    method: "post",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code !== 200) {
    Logger.log(`OpenAI HTTP ${code}: ${body.substring(0, 1000)}`);
    return null;
  }

  const jsonRes = JSON.parse(body);
  if (jsonRes.choices && jsonRes.choices[0] && jsonRes.choices[0].message) {
    return JSON.parse(jsonRes.choices[0].message.content);
  }
  Logger.log("OpenAI returned no choices: " + body.substring(0, 1000));
  return null;
}

// ==============================================================================
// 4. MCC LOOKUP
// ==============================================================================
function lookupMcc(query) {
  if (!query) return [];
  try {
    const url = MCC_API_URL + encodeURIComponent(query).replace(/%20/g, "+");
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const code = res.getResponseCode();
    const body = res.getContentText();
    Logger.log(`MCC lookup "${query}" -> HTTP ${code}: ${body.substring(0, 500)}`);
    if (code !== 200) return [];

    const json = JSON.parse(body);
    const list = Array.isArray(json.merchants) ? json.merchants : [];
    return list.slice(0, 3).map(m => ({
      mcc: m.MCC || "",
      name: m.displayName || m.Store || "",
      category: m.Category || ""
    })).filter(r => r.mcc !== "");
  } catch (err) {
    Logger.log("MCC lookup failed: " + err.toString());
    return [];
  }
}

function formatMccResults(results) {
  if (!results.length) return "No match found";
  return results.map(r => {
    let s = `${r.mcc}`;
    if (r.name) s += ` (${r.name}`;
    if (r.category) s += r.name ? ` - ${r.category})` : ` (${r.category})`;
    else if (r.name) s += ")";
    return s;
  }).join(" | ");
}

// ==============================================================================
// 5. MESSAGE / TEXT HELPERS
// ==============================================================================
// Legacy Telegram Markdown fails the whole message on stray _ * ` [
function escapeMd(s) {
  return String(s).replace(/([_*`\[])/g, "\\$1");
}

// Pulls "<label>: value" back out of the plain-text callback.message.text
function extractField(text, label) {
  const m = (text || "").match(new RegExp(label + ": (.+)"));
  return m ? m[1].trim() : "";
}

function buildLoggedMessage(header, description, subcategory, amount, merchant, mccText) {
  const stats = getSubcategoryStats(subcategory);
  return (`${header}\n\n` +
          `📝 *Item:* ${escapeMd(description)}\n` +
          (merchant ? `🏪 *Merchant:* ${escapeMd(merchant)}\n` : "") +
          (mccText ? `🔎 *MCC:* ${escapeMd(mccText)}\n` : "") +
          `🏷️ *Bucket:* ${subcategory}\n` +
          `💰 *Amount:* $${amount.toFixed(2)}\n\n` +
          `📊 *${subcategory} Remaining:* $${stats.remaining.toFixed(2)}\n` +
          stats.quotaText).trim();
}

// ==============================================================================
// 6. SHEET STATS HELPER
// ==============================================================================
function getSubcategoryStats(subcategory) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const dashboardSheet = ss.getSheetByName(DASHBOARD_TAB);
  const data = dashboardSheet.getDataRange().getValues();
  let remaining = 0;
  let quota = "—";

  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === subcategory) {
      remaining = parseFloat(data[i][4]) || 0;
      quota = data[i][5];
      break;
    }
  }

  // Dashboard quota is only used as a "this bucket has a daily quota" flag.
  // The actual number is computed below so it stays fixed through the day.
  let quotaText = "";
  if (quota !== "" && quota !== "—" && !isNaN(quota)) {
    const now = new Date();
    const totalDaysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = totalDaysInMonth - now.getDate() + 1; // includes today

    const spentToday = getSpentToday(ss, subcategory);
    const dailyRate = (remaining + spentToday) / daysLeft; // fixed for the day
    const quotaLeft = dailyRate - spentToday;

    quotaText = `🎯 *Daily Quota Left:* $${quotaLeft.toFixed(2)} (of $${dailyRate.toFixed(2)}/day)`;
  }
  return { remaining: remaining, quotaText: quotaText };
}

// Sum of today's tracker rows for a subcategory (col A date, B subcategory, C amount)
function getSpentToday(ss, subcategory) {
  const sheet = ss.getSheetByName(TRACKER_TAB);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const tz = Session.getScriptTimeZone();
  const todayStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

  let total = 0;
  rows.forEach(r => {
    // appendRow of "yyyy-MM-dd" is usually auto-converted to a Date by Sheets
    const rowDate = r[0] instanceof Date
      ? Utilities.formatDate(r[0], tz, "yyyy-MM-dd")
      : String(r[0]).trim();
    if (rowDate === todayStr && r[1] === subcategory) {
      total += parseFloat(r[2]) || 0;
    }
  });
  return total;
}

// ==============================================================================
// 7. DAILY MORNING SUMMARY TRIGGER (8:00 AM)
// ==============================================================================
function sendDailySummary() {
  const needsStats = getSubcategoryStats("Variable Monthly Needs");
  const wantsStats = getSubcategoryStats("Variable Monthly Wants");
  const today = new Date();
  const totalDaysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysRemaining = totalDaysInMonth - today.getDate() + 1;

  const message = `☀️ *Good Morning! Daily Budget Status*\n\n` +
                  `💳 *Needs Remaining:* $${needsStats.remaining.toFixed(2)}\n` +
                  (needsStats.quotaText ? `${needsStats.quotaText}\n\n` : "\n") +
                  `🛍️ *Wants Remaining:* $${wantsStats.remaining.toFixed(2)}\n` +
                  `🗓️ *Days Left in Month:* ${daysRemaining}\n\n` +
                  `_Send a PayNow screenshot or text to log expenses today!_`;

  // Sent to every allow-listed chat, not just whoever messaged most recently.
  ALLOWED_CHAT_IDS.forEach(chatId => sendTelegramMessage(chatId, message));
}

// ==============================================================================
// 8. TELEGRAM API UTILITIES
// ==============================================================================
function buildKeyboard(rowNumber, includeMcc) {
  const keyboard = [
    [
      { text: "➡️ Needs", callback_data: `reclass_${rowNumber}_Variable Monthly Needs` },
      { text: "➡️ Wants", callback_data: `reclass_${rowNumber}_Variable Monthly Wants` },
      { text: "➡️ Savings", callback_data: `reclass_${rowNumber}_Variable Investments` }
    ],
    [
      { text: "✅ Confirm", callback_data: `confirm_${rowNumber}` },
      { text: "❌ Undo", callback_data: `delete_${rowNumber}` }
    ]
  ];
  if (includeMcc) keyboard.unshift([{ text: "🔎 Check MCC", callback_data: `mcc_${rowNumber}` }]);
  return keyboard;
}

function sendTelegramWithButtons(chatId, text, rowNumber) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buildKeyboard(rowNumber, true) }
  };
  const res = UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) Logger.log("sendMessage failed: " + res.getContentText());
}

function editTelegramMessage(chatId, messageId, text, keyboard) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const payload = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "Markdown" };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) Logger.log("editMessageText failed: " + res.getContentText());
}

function removeInlineKeyboard(chatId, messageId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`;
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    muteHttpExceptions: true
  });
}

function answerCallbackQuery(callbackId, text = "") {
  const payload = { callback_query_id: callbackId };
  if (text) payload.text = text;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true });
}

function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" }), muteHttpExceptions: true });
}

// ==============================================================================
// 9. SETUP UTILITIES
// ==============================================================================
function setTelegramWebhook() {
  // Secret travels as a query param on the callback URL, since Apps Script
  // web apps can't read the X-Telegram-Bot-Api-Secret-Token header Telegram
  // would otherwise send. doPost() validates e.parameter.secret against it.
  const callbackUrl = `${WEBAPP_URL}?secret=${encodeURIComponent(WEBHOOK_SECRET)}`;
  Logger.log(UrlFetchApp.fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(callbackUrl)}`).getContentText());
}

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "sendDailySummary") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendDailySummary").timeBased().everyDays(1).atHour(8).create();
}
