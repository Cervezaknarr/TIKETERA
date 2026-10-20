// Verifica el email de entradas sin enviarlo: se intercepta el fetch a la API de Resend
process.env.RESEND_API_KEY = "re_test_key";
process.env.RESEND_FROM = "Ticketera <entradas@test.com>";
process.env.FRONTEND_URL = "https://ticketera.test";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), body: JSON.parse(options.body) });
  return new Response(JSON.stringify({ id: "email_123" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const { sendTicketsEmail } = require("../utils/mailer");

test("arma el email con un QR inline y el código de cada entrada", async () => {
  const sent = await sendTicketsEmail({
    purchase: {
      buyerName: "Juan <b>",
      buyerEmail: "juan@test.com",
      accessToken: "abc123",
    },
    event: { title: "Fiesta", date: new Date(), location: "Salón" },
    tickets: [{ code: "AAAAA-11111" }, { code: "BBBBB-22222" }],
  });

  assert.equal(sent, true);
  assert.equal(requests.length, 1);
  const { url, body } = requests[0];
  assert.match(url, /api\.resend\.com\/emails/);
  assert.equal(body.to, "juan@test.com");
  assert.equal(body.from, "Ticketera <entradas@test.com>");
  assert.equal(body.subject, "Tus entradas para Fiesta");
  assert.equal(body.attachments.length, 2);
  assert.equal(body.attachments[0].content_id, "qr-1");
  assert.match(body.html, /cid:qr-1/);
  assert.match(body.html, /cid:qr-2/);
  assert.match(body.html, /AAAAA-11111/);
  assert.match(body.html, /BBBBB-22222/);
  assert.match(body.html, /https:\/\/ticketera\.test\/#\/entradas\/abc123/);
  assert.match(body.html, /Juan &lt;b&gt;/); // el nombre se escapa
});
