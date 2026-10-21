const { Resend } = require("resend");
const QRCode = require("qrcode");

// El envío queda inactivo hasta que se configure RESEND_API_KEY
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/**
 * Link a la página donde el comprador ve sus entradas
 * @param {string} accessToken - Token privado de la compra
 */
const ticketsUrl = (accessToken) =>
  `${process.env.FRONTEND_URL || "http://localhost:5500"}/#/entradas/${accessToken}`;

/**
 * Enviar al comprador un email con el QR y el código de cada entrada
 * @param {{ purchase: object, event: object, tickets: object[] }} data
 * @returns {Promise<boolean>} true si se envió, false si el envío está inactivo
 */
const sendTicketsEmail = async ({ purchase, event, tickets }) => {
  if (!resend) {
    console.log(
      `[email inactivo] Entradas de ${purchase.buyerEmail}: ${ticketsUrl(purchase.accessToken)}`
    );
    return false;
  }

  // QR como imágenes inline (cid:): Gmail y otros bloquean imágenes en base64
  const attachments = await Promise.all(
    tickets.map(async (ticket, i) => ({
      filename: `entrada-${i + 1}.png`,
      content: await QRCode.toBuffer(ticket.code, { width: 300, margin: 2 }),
      contentId: `qr-${i + 1}`,
    }))
  );

  const ticketsHtml = tickets
    .map(
      (ticket, i) => `
      <div style="border:1px solid #e4e6ee;border-radius:12px;padding:16px;margin:12px 0;text-align:center">
        <p style="margin:0 0 8px;color:#6b7080">Entrada ${i + 1} de ${tickets.length}</p>
        <img src="cid:qr-${i + 1}" width="220" height="220" alt="QR ${esc(ticket.code)}">
        <p style="font-family:monospace;font-size:22px;letter-spacing:2px;margin:8px 0 0"><b>${esc(ticket.code)}</b></p>
      </div>`
    )
    .join("");

  const date = new Date(event.date).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
  });

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM,
    to: purchase.buyerEmail,
    subject: `Tus entradas para ${event.title}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#1c1e26">
        <h2>¡Hola ${esc(purchase.buyerName)}!</h2>
        <p>Estas son tus entradas${purchase.lotName ? ` (${esc(purchase.lotName)})` : ""} para <b>${esc(event.title)}</b>.</p>
        <p style="color:#6b7080">📅 ${esc(date)}<br>📍 ${esc(event.location)}</p>
        <p>Cada QR es para una persona. Si alguien no puede escanearlo, el staff puede ingresar el código a mano.</p>
        ${ticketsHtml}
        <p><a href="${ticketsUrl(purchase.accessToken)}">Ver mis entradas en la web</a></p>
      </div>`,
    attachments,
  });

  if (error) throw new Error(`Resend: ${error.message}`);
  return true;
};

module.exports = { sendTicketsEmail, ticketsUrl };
