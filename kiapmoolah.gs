
// ==============================================================================
// KIAP MOOLAH — CONFIGURATION
// ==============================================================================
const TELEGRAM_BOT_TOKEN = "YOUR_BOT_TOKEN";
const OPENAI_API_KEY = "YOUR_API_KEY";
const WEBAPP_URL = "YOUR_WEBAPP_URL";
const SPREADSHEET_ID = "YOUR_SHEET_ID";

const WEBHOOK_SECRET = "RANDOM_STRING";
const ALLOWED_CHAT_IDS = ["YOUR_CHAT_ID"];

const DASHBOARD_TAB = "DASHBOARD_SHEET_NAME";
const TRACKER_TAB = "TRACKER_SHEET_NAME";

const MCC_API_URL = "YOUR_MCC_CHECKER_SERVICE_URL";

const PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ==============================================================================
// 1. MAIN TELEGRAM WEBHOOK HANDLER
// ==============================================================================
function doPost(e) {
  try {
    const suppliedSecret = e.parameter && e.parameter.secret;

    if (suppliedSecret !== WEBHOOK_SECRET) {
      Logger.log("Rejected webhook: invalid secret");
      return HtmlService.createHtmlOutput("OK");
    }

    const data = JSON.parse(e.postData.contents);

    // --------------------------------------------------------------------------
    // CALLBACK QUERIES
    // --------------------------------------------------------------------------
    if (data.callback_query) {
      const callback = data.callback_query;
      const chatId = callback.message.chat.id.toString();

      if (ALLOWED_CHAT_IDS.indexOf(chatId) === -1) {
        Logger.log("Rejected callback from unauthorized chat: " + chatId);
        return HtmlService.createHtmlOutput("OK");
      }

      handleCallbackQuery(callback);
      return HtmlService.createHtmlOutput("OK");
    }

    if (!data.message) return HtmlService.createHtmlOutput("OK");

    const message = data.message;
    const chatId = message.chat.id.toString();

    if (ALLOWED_CHAT_IDS.indexOf(chatId) === -1) {
      Logger.log("Rejected message from unauthorized chat: " + chatId);
      return HtmlService.createHtmlOutput("OK");
    }

    const textPrompt = message.text || message.caption || "";

    // --------------------------------------------------------------------------
    // START COMMAND
    // --------------------------------------------------------------------------
    if (textPrompt.trim().toLowerCase() === "/start") {
      const welcomeMsg =
        `👋 *Wah, spending again?*\n\n` +
        `Welcome to *Kiap Moolah*! I'm here to make sure your budget doesn't magically disappear.\n\n` +
        `👇 *How to log an expense:*\n` +
        `1️⃣ *Text me:* "Kopi $1.50 DBS Visa"\n` +
        `2️⃣ *Snap a pic:* Send a PayNow or bank screenshot.\n\n` +
        `If I need more information, I'll ask before logging the transaction.\n\n` +
        `I'll do the math and let you know your daily quota.`;

      sendTelegramMessage(chatId, welcomeMsg);
      return HtmlService.createHtmlOutput("OK");
    }

    // --------------------------------------------------------------------------
    // CANCEL COMMAND
    // --------------------------------------------------------------------------
    if (textPrompt.trim().toLowerCase() === "/cancel") {
      const existed = clearPendingTransaction(chatId);

      sendTelegramMessage(
        chatId,
        existed
          ? "🗑️ Pending transaction cancelled. Nothing was added to your tracker."
          : "ℹ️ There is no pending transaction to cancel."
      );

      return HtmlService.createHtmlOutput("OK");
    }

    // --------------------------------------------------------------------------
    // CHECK FOR PENDING CLARIFICATION
    // --------------------------------------------------------------------------
    const pendingState = getPendingTransactionState(chatId);

    if (pendingState.status === "expired") {
      sendTelegramMessage(
        chatId,
        "⌛ Your previous pending transaction has expired. Nothing was logged. Please resend the transaction if you still want to record it."
      );

      return HtmlService.createHtmlOutput("OK");
    }

    if (pendingState.status === "active") {
      if (!message.text) {
        sendTelegramMessage(
          chatId,
          "✍️ Please reply with the purpose of the pending transaction in text, or send /cancel."
        );
        return HtmlService.createHtmlOutput("OK");
      }

      handleClarificationReply(chatId, textPrompt);
      return HtmlService.createHtmlOutput("OK");
    }

    // --------------------------------------------------------------------------
    // DOWNLOAD PHOTO IF PROVIDED
    // --------------------------------------------------------------------------
    let base64Image = null;
    let mimeType = "image/jpeg";

    if (message.photo) {
      const photoArray = message.photo;
      const fileId = photoArray[Math.max(0, photoArray.length - 2)].file_id;

      const fileRes = UrlFetchApp.fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
        { muteHttpExceptions: true }
      );

      const fileJson = JSON.parse(fileRes.getContentText());

      if (!fileJson.ok) {
        Logger.log("Telegram getFile failed: " + fileRes.getContentText());
        sendTelegramMessage(chatId, "⚠️ Couldn't download that photo. Please try again.");
        return HtmlService.createHtmlOutput("OK");
      }

      const imgRes = UrlFetchApp.fetch(
        `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileJson.result.file_path}`,
        { muteHttpExceptions: true }
      );

      if (imgRes.getResponseCode() !== 200) {
        Logger.log("Telegram image download failed: " + imgRes.getResponseCode());
        sendTelegramMessage(chatId, "⚠️ Couldn't download that photo. Please try again.");
        return HtmlService.createHtmlOutput("OK");
      }

      base64Image = Utilities.base64Encode(imgRes.getContent());
      mimeType = "image/jpeg";
    }

    if (!textPrompt && !base64Image) {
      sendTelegramMessage(chatId, "⚠️ Please send an expense description or a transaction screenshot.");
      return HtmlService.createHtmlOutput("OK");
    }

    // --------------------------------------------------------------------------
    // PARSE TRANSACTION
    // --------------------------------------------------------------------------
    let parsed;

    try {
      parsed = parseExpenseWithOpenAI(textPrompt, base64Image, mimeType);
    } catch (err) {
      Logger.log("OpenAI parser error: " + err.toString());
      sendTelegramMessage(chatId, "⚠️ Expense parser is temporarily unavailable. Please try again shortly.");
      return HtmlService.createHtmlOutput("OK");
    }

    if (
      !parsed ||
      typeof parsed.amount !== "number" ||
      !Number.isFinite(parsed.amount) ||
      parsed.amount <= 0
    ) {
      Logger.log("Unparseable result: " + JSON.stringify(parsed));
      sendTelegramMessage(chatId, "⚠️ Couldn't identify a valid transaction amount. Please try again.");
      return HtmlService.createHtmlOutput("OK");
    }

    // Normalise optional fields.
    parsed.description = parsed.description || "";
    parsed.merchant = parsed.merchant || "";
    parsed.counterparty = parsed.counterparty || "";
    parsed.payment_method = parsed.payment_method || "";
    parsed.transaction_type = parsed.transaction_type || "Transaction";

    // Keep only the last four account digits where identifiable.
    parsed.payment_method = sanitisePaymentMethod(parsed.payment_method);

    const validCategories = [
      "Variable Monthly Needs",
      "Variable Investments",
      "Variable Monthly Wants"
    ];

    const categoryValid =
      validCategories.indexOf(parsed.subcategory) !== -1;

    // Ask for clarification when the purpose or category is unknown.
    const needsClarification =
      parsed.needs_clarification === true ||
      !categoryValid ||
      !parsed.description;

    if (needsClarification) {
      savePendingTransaction(chatId, parsed);
      askTransactionPurpose(chatId, parsed);
      return HtmlService.createHtmlOutput("OK");
    }

    // --------------------------------------------------------------------------
    // LOG DIRECT PURCHASE
    // --------------------------------------------------------------------------
    const rowNumber = saveExpenseToSheet(parsed);

    if (!rowNumber) {
      sendTelegramMessage(chatId, "⚠️ Couldn't save that expense. Please try again.");
      return HtmlService.createHtmlOutput("OK");
    }

    const replyMsg = buildLoggedMessage(
      "✅ *Logged Expense!*",
      parsed.description,
      parsed.subcategory,
      parsed.amount,
      parsed.merchant,
      "",
      parsed.payment_method,
      parsed.counterparty
    );

    sendTelegramWithButtons(chatId, replyMsg, rowNumber);

  } catch (err) {
    Logger.log("Error in doPost: " + err.toString() + "\n" + (err.stack || ""));
  }

  return HtmlService.createHtmlOutput("OK");
}

// ==============================================================================
// 2. OPENAI TRANSACTION PARSER
// ==============================================================================
function parseExpenseWithOpenAI(textPrompt, base64Image, mimeType) {
  const url = "https://api.openai.com/v1/chat/completions";

  const systemInstruction = `You are a financial transaction parser for a user in Singapore.

Extract transaction details and classify expenses into EXACTLY ONE of these categories:

1. "Variable Monthly Needs" - Essentials, food, transport, groceries, household expenses.
2. "Variable Investments" - Stocks, crypto, investments, extra savings.
3. "Variable Monthly Wants" - Shopping, gadgets, entertainment, luxury purchases.

TRANSACTION TYPES:
- Card purchase
- PayNow transfer
- Bank transfer
- FAST transfer
- Cash withdrawal
- Refund
- Bill payment
- Other

IMPORTANT: Understand the underlying economic purpose, not merely the banking mechanism.

TRANSFER RULES:
- A bank notification may identify a recipient but not what the money was actually spent on.
- The recipient is NOT necessarily the merchant.
- A PayNow transfer to a person could represent a shared purchase, dinner, reimbursement, or transfer to the user's own account.
- Never assume the purpose based on the recipient's name.
- If a transfer's underlying purpose is not explicitly stated, set needs_clarification to true.
- If the user explicitly states the purpose, classify that purpose normally.
- Example: "PayNow $500 to friend for Adidas shoes" means description "Adidas shoes", category "Variable Monthly Wants".
- Example: "PayNow $500 to friend" has unknown purpose and needs clarification.
- Example: "Transfer to my own savings account" is an internal transfer, not spending. Set needs_clarification to true.

DESCRIPTION:
- For purchases, describe what was bought, not just how it was paid.
- Use concise descriptions such as "Adidas shoes", "Dinner", "Groceries".
- Do not use generic descriptions such as "PayNow transfer" when the underlying purpose is unknown.
- Do not invent a purchase purpose.
- If the purpose is unknown, leave description empty.

MERCHANT AND COUNTERPARTY:
- merchant means the actual shop or business where the purchase happened.
- counterparty means the person or account receiving a transfer.
- Never treat a person's name as a merchant.
- If a bank notification contains a recipient, extract it as counterparty.
- Do not store NRIC, FIN, or personal identification numbers.
- Do not store full bank account numbers.

PAYMENT METHOD:
- Identify the card, account, or payment method used.
- Examples: "DBS Visa", "UOB One", "OCBC FRANK Account (4001)", "OCBC Debit", "Apple Pay", "Cash", "PayNow".
- If Apple Pay is used and the underlying card is identifiable, prefer the card name.
- Never infer payment method from the merchant.
- Return an empty string if unknown.
- Retain at most the last four digits of an account number.

CATEGORY:
- If the underlying purchase purpose is unknown, do not guess a category.
- Set subcategory to an empty string and needs_clarification to true.
- If a transaction is clearly an internal transfer, set needs_clarification to true.

Return strictly JSON:
{
  "amount": <number>,
  "transaction_type": "<transaction type>",
  "description": "<underlying purchase description; empty if unknown>",
  "merchant": "<actual shop/business; empty if unknown>",
  "counterparty": "<transfer recipient; empty if unknown>",
  "payment_method": "<payment method; empty if unknown>",
  "subcategory": "<Variable Monthly Needs | Variable Investments | Variable Monthly Wants | empty string>",
  "needs_clarification": <true or false>
}`;

  const userContent = [];

  if (textPrompt) {
    userContent.push({
      type: "text",
      text: `User Input: ${textPrompt}`
    });
  } else {
    userContent.push({
      type: "text",
      text: "Extract transaction details from this image."
    });
  }

  if (base64Image) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${mimeType};base64,${base64Image}`,
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

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code !== 200) {
    Logger.log(`OpenAI HTTP ${code}: ${body.substring(0, 1000)}`);
    throw new Error("OpenAI parser request failed");
  }

  const json = JSON.parse(body);

  if (
    json.choices &&
    json.choices[0] &&
    json.choices[0].message
  ) {
    return JSON.parse(json.choices[0].message.content);
  }

  throw new Error("OpenAI returned no choices");
}

// ==============================================================================
// 3. PENDING TRANSACTION STORAGE
// ==============================================================================

// Each Telegram chat has one pending transaction.
// Stored in Apps Script Project Properties, not Google Sheets.

function getPendingKey(chatId) {
  return "PENDING_TRANSACTION_" + chatId;
}

function getPendingTransactionState(chatId) {
  const props = PropertiesService.getScriptProperties();
  const key = getPendingKey(chatId);
  const raw = props.getProperty(key);

  if (!raw) {
    return { status: "none", transaction: null };
  }

  try {
    const pending = JSON.parse(raw);

    if (Date.now() - pending.createdAt > PENDING_EXPIRY_MS) {
      props.deleteProperty(key);
      return { status: "expired", transaction: null };
    }

    return { status: "active", transaction: pending };

  } catch (err) {
    props.deleteProperty(key);
    Logger.log("Invalid pending transaction removed: " + err.toString());

    return { status: "none", transaction: null };
  }
}

function getPendingTransaction(chatId) {
  const state = getPendingTransactionState(chatId);
  return state.status === "active" ? state.transaction : null;
}

function hasPendingTransaction(chatId) {
  return getPendingTransactionState(chatId).status === "active";
}

function savePendingTransaction(chatId, parsed) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const existing = getPendingTransactionState(chatId);

    if (existing.status === "active") {
      throw new Error("A pending transaction already exists for this chat");
    }

    const pending = {
      createdAt: Date.now(),
      amount: parsed.amount,
      transaction_type: parsed.transaction_type || "Transaction",
      description: parsed.description || "",
      merchant: parsed.merchant || "",
      counterparty: parsed.counterparty || "",
      payment_method: sanitisePaymentMethod(parsed.payment_method || "")
    };

    PropertiesService.getScriptProperties().setProperty(
      getPendingKey(chatId),
      JSON.stringify(pending)
    );

  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function clearPendingTransaction(chatId) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const props = PropertiesService.getScriptProperties();
    const key = getPendingKey(chatId);
    const existed = props.getProperty(key) !== null;

    props.deleteProperty(key);

    return existed;

  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

// ==============================================================================
// 4. ASK FOR CLARIFICATION
// ==============================================================================
function askTransactionPurpose(chatId, pending) {
  let message =
    `❓ *A quick clarification before I log this transaction*\n\n` +
    `💰 *Amount:* $${pending.amount.toFixed(2)}\n` +
    `🔄 *Transaction:* ${escapeMd(pending.transaction_type)}\n`;

  if (pending.counterparty) {
    message += `👤 *Recipient:* ${escapeMd(pending.counterparty)}\n`;
  }

  if (pending.merchant) {
    message += `🏪 *Merchant:* ${escapeMd(pending.merchant)}\n`;
  }

  if (pending.payment_method) {
    message += `💳 *Payment Method:* ${escapeMd(pending.payment_method)}\n`;
  }

  message +=
    `\n*What was this transaction actually for?*\n\n` +
    `For example:\n` +
    `• Adidas shoes\n` +
    `• Dinner with friends\n` +
    `• Groceries\n` +
    `• Transfer to my own account\n\n` +
    `Reply with the purpose in plain text. I'll determine the description and budget category.\n\n` +
    `_Nothing has been logged yet. Send /cancel to discard._`;

  sendTelegramMessage(chatId, message);
}

// ==============================================================================
// 5. PROCESS CLARIFICATION REPLY
// ==============================================================================
function handleClarificationReply(chatId, answer) {
  const pending = getPendingTransaction(chatId);

  if (!pending) {
    sendTelegramMessage(
      chatId,
      "⌛ The pending transaction has expired. Please resend the transaction if you still want to record it."
    );
    return;
  }

  let resolution;

  try {
    resolution = resolvePendingTransaction(pending, answer);

  } catch (err) {
    Logger.log("Clarification resolution failed: " + err.toString());

    sendTelegramMessage(
      chatId,
      "⚠️ I couldn't process your answer. Your pending transaction is still saved. Please try again."
    );

    return;
  }

  // Ask another question if the answer is still unclear.
  if (!resolution || resolution.resolved !== true) {
    const question =
      resolution && resolution.clarification_question
        ? resolution.clarification_question
        : "Could you clarify what the money was used for?";

    sendTelegramMessage(
      chatId,
      `🤔 ${escapeMd(question)}\n\n_Reply with more detail, or send /cancel._`
    );

    return;
  }

  // Internal transfer: do not count as spending.
  if (resolution.exclude === true) {
    clearPendingTransaction(chatId);

    sendTelegramMessage(
      chatId,
      `↪️ *Not logged as an expense.*\n\n` +
      `I've treated this as a transfer rather than spending.\n\n` +
      `💰 Amount: $${pending.amount.toFixed(2)}\n` +
      `_Your budget and tracker have not been changed._`
    );

    return;
  }

  const validCategories = [
    "Variable Monthly Needs",
    "Variable Investments",
    "Variable Monthly Wants"
  ];

  if (
    validCategories.indexOf(resolution.subcategory) === -1 ||
    !resolution.description
  ) {
    sendTelegramMessage(
      chatId,
      "🤔 I still need a clearer description of what you purchased. What was the money used for?"
    );

    return;
  }

  const finalTransaction = {
    amount: pending.amount,
    description: resolution.description,
    subcategory: resolution.subcategory,
    merchant: pending.merchant || "",
    counterparty: pending.counterparty || "",
    payment_method: pending.payment_method || ""
  };

  // Save first. Only clear pending after successful sheet write.
  const rowNumber = saveExpenseToSheet(finalTransaction);

  if (!rowNumber) {
    sendTelegramMessage(
      chatId,
      "⚠️ I understood your answer but couldn't save the transaction. Your pending transaction is retained; please try replying again."
    );

    return;
  }

  clearPendingTransaction(chatId);

  const replyMsg = buildLoggedMessage(
    "✅ *Clarification received — logged!*",
    finalTransaction.description,
    finalTransaction.subcategory,
    finalTransaction.amount,
    finalTransaction.merchant,
    "",
    finalTransaction.payment_method,
    finalTransaction.counterparty
  );

  sendTelegramWithButtons(chatId, replyMsg, rowNumber);
}

// ==============================================================================
// 6. AI CLARIFICATION RESOLVER
// ==============================================================================
function resolvePendingTransaction(pending, answer) {
  const url = "https://api.openai.com/v1/chat/completions";

  const systemInstruction = `You resolve missing information for a financial transaction in Singapore.

ORIGINAL BANK TRANSACTION:
${JSON.stringify(pending)}

USER'S CLARIFICATION:
${answer}

Determine what the money was actually spent on.

ALLOWED CATEGORIES:
- Variable Monthly Needs: essentials, food, transport, groceries, household expenses.
- Variable Investments: stocks, crypto, investments, extra savings.
- Variable Monthly Wants: shopping, gadgets, entertainment, luxury purchases.

EXAMPLES:
- "Adidas shoes" => description "Adidas shoes", Variable Monthly Wants.
- "Shared purchase of Adidas goods" => description "Adidas shopping", Variable Monthly Wants.
- "Dinner" => description "Dinner", Variable Monthly Needs.
- "Groceries" => description "Groceries", Variable Monthly Needs.
- "Transferred to my own savings account" => exclude true.
- "Moved money between my own accounts" => exclude true.
- "Invested in shares" => description "Shares investment", Variable Investments.

RULES:
- Do not confuse the recipient with the merchant.
- Do not assume a transfer is an expense.
- Only exclude a transaction when the user clearly indicates it is an internal transfer or not spending.
- If the answer is too vague to identify the purpose, set resolved to false and ask a concise follow-up question.
- If the category is unclear, ask rather than guess.
- Do not change the original transaction amount or payment method.
- Do not invent merchant names.
- The description should identify the underlying purchase or purpose, not the transfer mechanism.

Return strictly JSON:
{
  "resolved": <true or false>,
  "exclude": <true or false>,
  "description": "<concise expense description>",
  "subcategory": "<Variable Monthly Needs | Variable Investments | Variable Monthly Wants | empty string>",
  "clarification_question": "<short follow-up question if unresolved; otherwise empty string>"
}`;

  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: answer }
    ],
    response_format: { type: "json_object" },
    temperature: 0.1
  };

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    Logger.log("Clarification API error: " + response.getContentText().substring(0, 1000));
    throw new Error("OpenAI clarification request failed");
  }

  const json = JSON.parse(response.getContentText());

  if (!json.choices || !json.choices[0] || !json.choices[0].message) {
    throw new Error("OpenAI returned no clarification result");
  }

  return JSON.parse(json.choices[0].message.content);
}

// ==============================================================================
// 7. SAVE EXPENSE TO GOOGLE SHEETS
// ==============================================================================
function saveExpenseToSheet(parsed) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const trackerSheet = ss.getSheetByName(TRACKER_TAB);

    if (!trackerSheet) {
      throw new Error("Tracker sheet not found: " + TRACKER_TAB);
    }

    const todayStr = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd"
    );

    // A: Date
    // B: Subcategory
    // C: Amount
    // D: Description
    // E: Source
    // F: Payment Method
    trackerSheet.appendRow([
      todayStr,
      parsed.subcategory,
      parsed.amount,
      parsed.description,
      "Telegram Bot",
      parsed.payment_method || ""
    ]);

    SpreadsheetApp.flush();

    return trackerSheet.getLastRow();

  } catch (err) {
    Logger.log("Sheet write failed: " + err.toString());
    return null;

  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

// ==============================================================================
// 8. BUTTON CALLBACK PROCESSOR
// ==============================================================================
function handleCallbackQuery(callback) {
  const callbackId = callback.id;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const actionData = callback.data;

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const trackerSheet = ss.getSheetByName(TRACKER_TAB);

  if (!trackerSheet) {
    answerCallbackQuery(callbackId, "Tracker sheet not found.");
    return;
  }

  // Confirm.
  if (actionData.startsWith("confirm_")) {
    answerCallbackQuery(callbackId, "✅ Locked & Confirmed!");
    removeInlineKeyboard(chatId, messageId);
    return;
  }

  answerCallbackQuery(callbackId);

  // MCC lookup.
  if (actionData.startsWith("mcc_")) {
    const rowNum = parseInt(actionData.split("_")[1], 10);

    if (rowNum > 1 && rowNum <= trackerSheet.getLastRow()) {
      const subcat = trackerSheet.getRange(rowNum, 2).getValue();
      const amount = parseFloat(trackerSheet.getRange(rowNum, 3).getValue());
      const desc = trackerSheet.getRange(rowNum, 4).getValue();
      const paymentMethod = trackerSheet.getRange(rowNum, 6).getValue();

      const msgText = callback.message.text || "";
      const merchant = extractField(msgText, "Merchant");
      const counterparty = extractField(msgText, "Recipient");
      const mccText = formatMccResults(lookupMcc(merchant || desc));

      const updatedMsg = buildLoggedMessage(
        "✅ *Logged Expense!*",
        desc,
        subcat,
        amount,
        merchant,
        mccText,
        paymentMethod,
        counterparty
      );

      editTelegramMessage(
        chatId,
        messageId,
        updatedMsg,
        buildKeyboard(rowNum, false)
      );
    }

    return;
  }

  // Reclassify.
  if (actionData.startsWith("reclass_")) {
    const firstUnderscore = actionData.indexOf("_");
    const secondUnderscore = actionData.indexOf("_", firstUnderscore + 1);

    const rowNum = parseInt(
      actionData.substring(firstUnderscore + 1, secondUnderscore),
      10
    );

    const newSubcat = actionData.substring(secondUnderscore + 1);

    if (rowNum > 1 && rowNum <= trackerSheet.getLastRow()) {
      trackerSheet.getRange(rowNum, 2).setValue(newSubcat);
      SpreadsheetApp.flush();

      const itemDesc = trackerSheet.getRange(rowNum, 4).getValue();
      const amount = parseFloat(trackerSheet.getRange(rowNum, 3).getValue());
      const paymentMethod = trackerSheet.getRange(rowNum, 6).getValue();

      const msgText = callback.message.text || "";
      const merchant = extractField(msgText, "Merchant");
      const counterparty = extractField(msgText, "Recipient");
      const mccText = extractField(msgText, "MCC");

      const updatedMsg = buildLoggedMessage(
        "✏️ *Reclassified & Locked!*",
        itemDesc,
        newSubcat,
        amount,
        merchant,
        mccText,
        paymentMethod,
        counterparty
      );

      editTelegramMessage(chatId, messageId, updatedMsg);
      removeInlineKeyboard(chatId, messageId);
    }

    return;
  }

  // Delete / Undo.
  if (actionData.startsWith("delete_")) {
    const rowNum = parseInt(actionData.split("_")[1], 10);

    if (rowNum > 1 && rowNum <= trackerSheet.getLastRow()) {
      const itemDesc = trackerSheet.getRange(rowNum, 4).getValue();
      const amount = trackerSheet.getRange(rowNum, 3).getValue();

      trackerSheet.deleteRow(rowNum);
      SpreadsheetApp.flush();

      editTelegramMessage(
        chatId,
        messageId,
        `🗑️ *Deleted!* Removed *$${amount}* (${escapeMd(itemDesc)}) from your tracker.`
      );

      removeInlineKeyboard(chatId, messageId);
    }
  }
}

// ==============================================================================
// 9. MCC LOOKUP
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

    if (r.category) {
      s += r.name ? ` - ${r.category})` : ` (${r.category})`;
    } else if (r.name) {
      s += ")";
    }

    return s;
  }).join(" | ");
}

// ==============================================================================
// 10. MESSAGE / TEXT HELPERS
// ==============================================================================
function escapeMd(s) {
  return String(s || "").replace(/([_*`\[])/g, "\\$1");
}

function extractField(text, label) {
  // Supports Telegram Markdown such as *Merchant:* Adidas.
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const m = (text || "").match(
    new RegExp(escapedLabel + ":\\*? (.+)")
  );

  return m ? m[1].trim() : "";
}

function sanitisePaymentMethod(value) {
  let method = String(value || "");

  // Remove long digit sequences, preserving at most a trailing four-digit
  // account/card reference where the model has included one.
  method = method.replace(/\d{5,}/g, match => match.slice(-4));

  return method.trim();
}

function buildLoggedMessage(
  header,
  description,
  subcategory,
  amount,
  merchant,
  mccText,
  paymentMethod,
  counterparty
) {
  const stats = getSubcategoryStats(subcategory);

  return (
    `${header}\n\n` +
    `📝 *Item:* ${escapeMd(description)}\n` +
    (merchant ? `🏪 *Merchant:* ${escapeMd(merchant)}\n` : "") +
    (counterparty ? `👤 *Recipient:* ${escapeMd(counterparty)}\n` : "") +
    (paymentMethod ? `💳 *Payment Method:* ${escapeMd(paymentMethod)}\n` : "") +
    (mccText ? `🔎 *MCC:* ${escapeMd(mccText)}\n` : "") +
    `🏷️ *Bucket:* ${subcategory}\n` +
    `💰 *Amount:* $${amount.toFixed(2)}\n\n` +
    `📊 *${subcategory} Remaining:* $${stats.remaining.toFixed(2)}\n` +
    stats.quotaText
  ).trim();
}

// ==============================================================================
// 11. SHEET STATS HELPER
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

  let quotaText = "";

  if (quota !== "" && quota !== "—" && !isNaN(quota)) {
    const now = new Date();

    const totalDaysInMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0
    ).getDate();

    const daysLeft = totalDaysInMonth - now.getDate() + 1;
    const spentToday = getSpentToday(ss, subcategory);

    const dailyRate = (remaining + spentToday) / daysLeft;
    const quotaLeft = dailyRate - spentToday;

    quotaText =
      `🎯 *Daily Quota Left:* $${quotaLeft.toFixed(2)} ` +
      `(of $${dailyRate.toFixed(2)}/day)`;
  }

  return {
    remaining: remaining,
    quotaText: quotaText
  };
}

function getSpentToday(ss, subcategory) {
  const sheet = ss.getSheetByName(TRACKER_TAB);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return 0;

  const tz = Session.getScriptTimeZone();

  const todayStr = Utilities.formatDate(
    new Date(),
    tz,
    "yyyy-MM-dd"
  );

  const rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

  let total = 0;

  rows.forEach(r => {
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
// 12. DAILY MORNING SUMMARY TRIGGER
// ==============================================================================
function sendDailySummary() {
  const needsStats = getSubcategoryStats("Variable Monthly Needs");
  const wantsStats = getSubcategoryStats("Variable Monthly Wants");

  const today = new Date();

  const totalDaysInMonth = new Date(
    today.getFullYear(),
    today.getMonth() + 1,
    0
  ).getDate();

  const daysRemaining = totalDaysInMonth - today.getDate() + 1;

  const message =
    `☀️ *Good Morning! Daily Budget Status*\n\n` +
    `💳 *Needs Remaining:* $${needsStats.remaining.toFixed(2)}\n` +
    (needsStats.quotaText ? `${needsStats.quotaText}\n\n` : "\n") +
    `🛍️ *Wants Remaining:* $${wantsStats.remaining.toFixed(2)}\n` +
    `🗓️ *Days Left in Month:* ${daysRemaining}\n\n` +
    `_Send a PayNow screenshot or text to log expenses today!_`;

  ALLOWED_CHAT_IDS.forEach(chatId => {
    sendTelegramMessage(chatId, message);
  });
}

// ==============================================================================
// 13. TELEGRAM KEYBOARDS AND API UTILITIES
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

  if (includeMcc) {
    keyboard.unshift([
      { text: "🔎 Check MCC", callback_data: `mcc_${rowNumber}` }
    ]);
  }

  return keyboard;
}

function sendTelegramWithButtons(chatId, text, rowNumber) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: buildKeyboard(rowNumber, true)
    }
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    Logger.log("sendMessage failed: " + res.getContentText());
  }
}

function editTelegramMessage(chatId, messageId, text, keyboard) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "Markdown"
  };

  if (keyboard) {
    payload.reply_markup = {
      inline_keyboard: keyboard
    };
  }

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    Logger.log("editMessageText failed: " + res.getContentText());
  }
}

function removeInlineKeyboard(chatId, messageId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`;

  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    }),
    muteHttpExceptions: true
  });
}

function answerCallbackQuery(callbackId, text) {
  const payload = {
    callback_query_id: callbackId
  };

  if (text) payload.text = text;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;

  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown"
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    Logger.log("Telegram sendMessage failed: " + res.getContentText());
  }
}

// ==============================================================================
// 14. SETUP UTILITIES
// ==============================================================================
function setTelegramWebhook() {
  const callbackUrl =
    `${WEBAPP_URL}?secret=${encodeURIComponent(WEBHOOK_SECRET)}`;

  const response = UrlFetchApp.fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(callbackUrl)}`
  );

  Logger.log(response.getContentText());
}

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === "sendDailySummary") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("sendDailySummary")
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();
}
