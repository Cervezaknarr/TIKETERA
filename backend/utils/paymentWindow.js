// Cuánto tiempo tiene el comprador para pagar, y cuánto se le reserva el cupo.
// Cerca del agotamiento, las compras sin pagar traban entradas: cuanto más corta
// la ventana, antes vuelven a estar a la venta. La retención es la ventana más un
// margen para los pagos que se están acreditando justo al vencer

const DEFAULT_WINDOW_MINUTES = 10;
const HOLD_MARGIN_MINUTES = 5;

/**
 * Minutos que dura la sesión de pago en la pasarela (PAYMENT_WINDOW_MINUTES)
 */
const paymentWindowMinutes = () =>
  Number(process.env.PAYMENT_WINDOW_MINUTES) || DEFAULT_WINDOW_MINUTES;

/**
 * Minutos que se reserva el cupo de una compra sin pagar (PURCHASE_HOLD_MINUTES)
 */
const holdMinutes = () =>
  Number(process.env.PURCHASE_HOLD_MINUTES) || paymentWindowMinutes() + HOLD_MARGIN_MINUTES;

module.exports = { paymentWindowMinutes, holdMinutes };
