import express from "express";
import dotenv from "dotenv";
import crypto from "node:crypto";

dotenv.config();
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

const SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;
const SITE_URL = process.env.SITE_URL;
const PORT = process.env.PORT || 3000;

// ВАЖНО: каталог и цены хранятся на сервере. Клиент не передаёт стоимость.
const catalog = {
  1: { title: "Шашлык", price: 500 },
  2: { title: "Шашлык из курицы", price: 420 },
  3: { title: "Люля-кебаб", price: 390 },
  4: { title: "Картофель фри", price: 180 },
  5: { title: "Овощи на гриле", price: 230 },
  6: { title: "Картофель по-деревенски", price: 200 },
  7: { title: "Борщ", price: 300 },
  8: { title: "Куриный суп", price: 280 }
};

function authHeader() {
  return "Basic " + Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString("base64");
}

app.post("/api/create-payment", async (req, res) => {
  try {
    if (!SHOP_ID || !SECRET_KEY || !SITE_URL) {
      return res.status(503).json({ error: "Платёжный сервер ещё не настроен: проверьте переменные окружения." });
    }
    const { items, name, phone, method, address, comment } = req.body || {};
    if (!Array.isArray(items) || items.length === 0 || !String(name || "").trim() || !String(phone || "").trim()) {
      return res.status(400).json({ error: "Укажите имя, телефон и блюда заказа." });
    }
    if (!["pickup", "delivery"].includes(method)) {
      return res.status(400).json({ error: "Выберите самовывоз или доставку." });
    }
    if (method === "delivery" && !String(address || "").trim()) {
      return res.status(400).json({ error: "Для доставки укажите адрес." });
    }

    let total = 0;
    const validated = [];
    for (const item of items) {
      const product = catalog[Number(item.productId)];
      const quantity = Number(item.quantity);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 30) {
        return res.status(400).json({ error: "В заказе обнаружено некорректное блюдо или количество." });
      }
      total += product.price * quantity;
      validated.push({ title: product.title, quantity, unitPrice: product.price });
    }
    if (total <= 0 || total > 100000) {
      return res.status(400).json({ error: "Сумма заказа вне допустимого диапазона." });
    }

    const orderId = crypto.randomUUID();
    const paymentBody = {
      amount: { value: total.toFixed(2), currency: "RUB" },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: `${SITE_URL.replace(/\\/$/, "")}/?payment=return&order=${encodeURIComponent(orderId)}`
      },
      description: `Заказ кафе «Домашняя кухня» №${orderId.slice(0, 8)}`,
      metadata: {
        order_id: orderId,
        customer_name: String(name).trim().slice(0, 120),
        customer_phone: String(phone).trim().slice(0, 40),
        fulfillment: method,
        address: String(address || "").trim().slice(0, 300),
        comment: String(comment || "").trim().slice(0, 1000),
        items: JSON.stringify(validated)
      }
    };

    const response = await fetch("https://api.yookassa.ru/v3/payments", {
      method: "POST",
      headers: {
        "Authorization": authHeader(),
        "Idempotence-Key": orderId,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(paymentBody)
    });
    const payment = await response.json();
    if (!response.ok) {
      console.error("YooKassa create payment failed", response.status, payment);
      return res.status(502).json({ error: "Платёжный сервис не смог создать платёж. Попробуйте позже." });
    }

    // Внимание: заказ необходимо сохранить в БД и направить сотрудникам кафе.
    // Здесь возвращаем URL защищённой платёжной страницы.
    return res.json({
      paymentId: payment.id,
      confirmationUrl: payment.confirmation?.confirmation_url
    });
  } catch (error) {
    console.error("create-payment error", error);
    return res.status(500).json({ error: "Внутренняя ошибка при создании платежа." });
  }
});

// YooKassa уведомляет этот endpoint о статусе платежа.
// В production дополнительно храните заказы/статусы в БД и сверяйте payment ID, сумму и order_id.
app.post("/api/yookassa-webhook", async (req, res) => {
  try {
    const event = req.body?.event;
    const paymentId = req.body?.object?.id;
    if (!paymentId || !["payment.succeeded", "payment.canceled", "payment.waiting_for_capture"].includes(event)) {
      return res.sendStatus(200);
    }

    const response = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
      headers: { "Authorization": authHeader() }
    });
    const payment = await response.json();
    if (!response.ok) return res.sendStatus(500);

    if (payment.status === "succeeded") {
      // TODO production: надёжно записать успешную оплату в БД и уведомить кафе
      // (например, email/Telegram/кассовая система). Не полагайтесь только на return_url.
      console.log("PAYMENT SUCCEEDED", payment.id, payment.metadata?.order_id, payment.amount?.value);
    } else {
      console.log("PAYMENT STATUS", payment.id, payment.status);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("webhook error", error);
    return res.sendStatus(500);
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`API listening on ${PORT}`));
