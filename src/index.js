const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "google/gemini-2.5-flash"; 

// تابع کمکی برای پچ کردن باگ کاراکترهای غیرمجاز در حالت HTML تلگرام
function escapeHTML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("This endpoint is for Telegram webhooks.", { status: 200 });
    }

    try {
      const body = await request.json();
      if (!body.message && !body.callback_query) {
        return new Response("OK", { status: 200 });
      }
      ctx.waitUntil(handleTelegramUpdate(body, env));
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Worker Global Error:", error.message);
      return new Response("OK", { status: 200 });
    }
  }
};

async function handleTelegramUpdate(body, env) {
  let chatId, messageId, userText, firstName, isCallback = false, callbackData = null;

  const sendMessage = async (cId, text, replyId = null, parseMode = "HTML", replyMarkup = null) => {
    const payload = { chat_id: cId, text: text };
    if (replyId) payload.reply_to_message_id = replyId;
    if (parseMode) payload.parse_mode = parseMode;
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) console.error("Telegram Send Error:", await res.text());
  };

  const sendTyping = async (cId) => {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cId, action: "typing" })
    });
  };

  if (body.callback_query) {
    isCallback = true;
    chatId = body.callback_query.message.chat.id;
    messageId = body.callback_query.message.message_id;
    callbackData = body.callback_query.data;
    firstName = body.callback_query.from.first_name || "User";
  } else {
    chatId = body.message.chat.id;
    messageId = body.message.message_id;
    userText = body.message.text;
    firstName = body.message.from.first_name || "User";
  }

  try {
    const mainMenuMarkup = {
      inline_keyboard: [
        [
          { text: "🤖 لیست مدل‌های رایگان", callback_data: "menu_models" },
          { text: "⚙️ مدل فعال فعلی", callback_data: "menu_current" }
        ],
        [
          { text: "🧹 پاک کردن حافظه", callback_data: "menu_clear" }
        ]
      ]
    };

    if (isCallback) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: body.callback_query.id })
      });

      if (callbackData === "menu_models") {
        await sendTyping(chatId);
        await listModels(chatId, sendMessage);
      } 
      else if (callbackData === "menu_current") {
        await showCurrentModel(chatId, messageId, env, sendMessage);
      }
      else if (callbackData === "menu_clear") {
        await clearMemory(chatId, env, sendMessage);
      }
      return;
    }

    if (!userText) return;

    if (userText.startsWith("/start")) {
      await sendMessage(chatId, `سلام <b>${firstName}</b>!\nمن ربات متصل به OpenRouter هستم.\n\nبرای مدیریت ربات می‌توانید از دکمه‌های زیر استفاده کنید یا دستورات را بفرستید.`, null, "HTML", mainMenuMarkup);
      return;
    }

    if (userText.startsWith("/currentmodel")) {
      await showCurrentModel(chatId, messageId, env, sendMessage);
      return;
    }

    if (userText.startsWith("/model")) {
      await sendTyping(chatId);
      await listModels(chatId, sendMessage);
      return;
    }

    if (userText.startsWith("/clear")) {
      await clearMemory(chatId, env, sendMessage);
      return;
    }

    if (userText.includes(":free")) {
      const cleanModelInput = userText.trim();
      if (env.KV_BOT) await env.KV_BOT.put(`user_model_${chatId}`, cleanModelInput);
      await sendMessage(chatId, `✅ مدل فعال شما با موفقیت به این مورد تغییر یافت:\n\n<code>${cleanModelInput}</code>`, messageId, "HTML");
      return;
    }

    await sendTyping(chatId);

    // ۱. خواندن مدل انتخابی کاربر یا استفاده از مدل پیش‌فرض
    const userModel = await env.KV_BOT.get(`user_model_${chatId}`) || DEFAULT_MODEL;

    // ۲. خواندن تاریخچه چت از KV
    const contextKey = `user_context_${chatId}`;
    let chatContext = [];
    const savedContext = await env.KV_BOT.get(contextKey);

    if (savedContext) {
      try {
        chatContext = JSON.parse(savedContext);
      } catch (e) {
        chatContext = [];
      }
    }

    // ۳. اضافه کردن پیام جدید کاربر به تاریخچه
    chatContext.push({ role: "user", content: userText });

    // محدود کردن تاریخچه به ۱۰ پیام اخیر برای کنترل ریسپانس و توکن
    if (chatContext.length > 10) {
      chatContext = chatContext.slice(-10);
    }

    // ۴. ارسال درخواست به OpenRouter به همراه کل تاریخچه (messages)
    const openRouterResponse = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/mcuteangel/Telegram-openrouter-bot",
        "X-Title": "Telegram AI Bot"
      },
      body: JSON.stringify({
        model: userModel,
        messages: chatContext
      })
    });

    if (!openRouterResponse.ok) {
      const errorText = await openRouterResponse.text();
      throw new Error(`OpenRouter (${userModel}) Error: ${openRouterResponse.status}. Details: ${errorText}`);
    }

    const aiData = await openRouterResponse.json();
    const aiReply = aiData.choices?.[0]?.message?.content || "خطا در دریافت پاسخ از هوش مصنوعی.";

    // ۵. اضافه کردن پاسخ هوش مصنوعی به تاریخچه و ذخیره مجدد در KV
    chatContext.push({ role: "assistant", content: aiReply });
    if (chatContext.length > 10) {
      chatContext = chatContext.slice(-10);
    }
    await env.KV_BOT.put(contextKey, JSON.stringify(chatContext));

    // ۶. ارسال پاسخ نهایی به کاربر در تلگرام با اسکیپ کردن تگ‌های مخرب هوش مصنوعی
    await sendMessage(chatId, escapeHTML(aiReply), messageId, "HTML");

  } catch (error) {
    console.error("Process Error:", error.message);
    try {
      await sendMessage(chatId, `⚠️ خطا در پردازش:\n<code>${escapeHTML(error.message)}</code>`, null, "HTML");
    } catch (e) {}
  }
}

async function showCurrentModel(chatId, messageId, env, sendMessage) {
  let activeModel = DEFAULT_MODEL;
  let isCustom = false;
  if (env.KV_BOT) {
    const savedModel = await env.KV_BOT.get(`user_model_${chatId}`);
    if (savedModel) {
      activeModel = savedModel;
      isCustom = true;
    }
  }
  let statusText = `⚙️ <b>مدل فعال شما در حال حاضر:</b> \n\n<code>${activeModel}</code> \n\n`;
  statusText += !isCustom ? `💡 این مدل به صورت <b>پیش‌فرض</b> تنظیم شده است.` : `✅ این مدل توسط شما انتخاب و در حافظه ذخیره شده است.`;
  await sendMessage(chatId, statusText, null, "HTML");
}

async function listModels(chatId, sendMessage) {
  const modelsResponse = await fetch(`${BASE_URL}/models`);
  if (!modelsResponse.ok) throw new Error("خطا در دریافت لیست مدل‌ها از OpenRouter");
  
  const modelsData = await modelsResponse.json();
  const freeModels = modelsData.data.filter(m => m.id.endsWith(":free"));

  if (freeModels.length === 0) {
    await sendMessage(chatId, "در حال حاضر مدل رایگانی در OpenRouter یافت نشد.", null, "HTML");
    return;
  }

  let messageText = "🤖 <b>لیست مدل‌های رایگان و زنده OpenRouter</b>\n\n";
  messageText += "برای تغییر مدل، روی کد هرکدام که خواستید ضربه بزنید تا کپی شود، سپس آن را برای من ارسال کنید:\n\n";
  freeModels.forEach((model) => {
    const cleanName = model.name.replace(" (free)", "").replace(":free", "");
    messageText += `🔹 <b>${cleanName}</b>\n<code>${model.id}</code>\n\n`;
  });
  await sendMessage(chatId, messageText, null, "HTML");
}

async function clearMemory(chatId, env, sendMessage) {
  if (env.KV_BOT) {
    await env.KV_BOT.delete(`user_context_${chatId}`);
  }
  await sendMessage(chatId, "🧹 <b>تاریخچه چت شما با موفقیت پاک شد!</b>\n\nمدل انتخابی شما حفظ شده است.", null, "HTML");
}