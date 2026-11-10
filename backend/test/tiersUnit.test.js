const test = require("node:test");
const assert = require("node:assert");
const { lockedLotIds } = require("../utils/tiers");

let n = 0;
const lot = (over = {}) => {
  n += 1;
  return {
    id: `l${n}`,
    eventId: "e1",
    afterPrevious: false,
    position: n,
    createdAt: new Date(2026, 0, 1, 0, 0, n),
    ticketsAvailable: 10,
    ...over,
  };
};
const chained = (over = {}) => lot({ afterPrevious: true, ...over });
const ids = (set) => [...set].sort();

test("sin lotes o sin afterPrevious no bloquea nada", () => {
  assert.strictEqual(lockedLotIds([]).size, 0);
  assert.strictEqual(lockedLotIds(undefined).size, 0);
  const lots = [lot(), lot({ ticketsAvailable: 0 }), lot()];
  assert.strictEqual(lockedLotIds(lots).size, 0);
});

test("cadena de 3: solo el primero con cupo es comprable", () => {
  const [a, b, c] = [lot(), chained(), chained()];
  assert.deepStrictEqual(ids(lockedLotIds([a, b, c])), [b.id, c.id].sort());
  a.ticketsAvailable = 0;
  assert.deepStrictEqual(ids(lockedLotIds([a, b, c])), [c.id]);
  b.ticketsAvailable = 0;
  assert.strictEqual(lockedLotIds([a, b, c]).size, 0);
  c.ticketsAvailable = 0; // cadena agotada
  assert.strictEqual(lockedLotIds([a, b, c]).size, 0);
});

test("el orden de entrada no importa: manda position y luego createdAt/id", () => {
  const [a, b, c] = [lot({ position: 0 }), chained({ position: 1 }), chained({ position: 2 })];
  assert.deepStrictEqual(ids(lockedLotIds([c, b, a])), [b.id, c.id].sort());
  const x = chained({ position: 5, createdAt: new Date(2026, 0, 2) });
  const y = lot({ position: 5, createdAt: new Date(2026, 0, 1) });
  assert.deepStrictEqual(ids(lockedLotIds([x, y])), [x.id]);
  const p = lot({ id: "a", position: 7, createdAt: new Date(2026, 0, 3) });
  const q = chained({ id: "b", position: 7, createdAt: new Date(2026, 0, 3) });
  assert.deepStrictEqual(ids(lockedLotIds([q, p])), ["b"]);
});

test("una tanda anterior que recupera cupo vuelve a bloquear la siguiente", () => {
  const [a, b] = [lot({ ticketsAvailable: 0 }), chained()];
  assert.strictEqual(lockedLotIds([a, b]).size, 0);
  a.ticketsAvailable = 2;
  assert.deepStrictEqual(ids(lockedLotIds([a, b])), [b.id]);
});

test("varias cadenas: un lote paralelo en medio abre una cadena nueva", () => {
  const g1 = lot({ ticketsAvailable: 0 });
  const g2 = chained();
  const g3 = chained();
  const v1 = lot(); // paralelo: cabeza de otra cadena
  const v2 = chained();
  assert.deepStrictEqual(ids(lockedLotIds([g1, g2, g3, v1, v2])), [g3.id, v2.id].sort());
  // g2 con cupo no afecta a la cadena nueva
  v1.ticketsAvailable = 0;
  assert.deepStrictEqual(ids(lockedLotIds([g1, g2, g3, v1, v2])), [g3.id]);
});

test("la cabeza con cupo bloquea toda la cadena, aunque un intermedio esté agotado", () => {
  const [a, b, c] = [lot(), chained({ ticketsAvailable: 0 }), chained()];
  assert.deepStrictEqual(ids(lockedLotIds([a, b, c])), [b.id, c.id].sort());
});

test("el primer lote del evento con afterPrevious es cabeza: no espera a nada", () => {
  const [a, b] = [chained(), chained()];
  assert.deepStrictEqual(ids(lockedLotIds([a, b])), [b.id]);
  a.ticketsAvailable = 0;
  assert.strictEqual(lockedLotIds([a, b]).size, 0);
});

test("lotes en paralelo (afterPrevious=false) nunca se bloquean", () => {
  const a = lot({ ticketsAvailable: 0 });
  const b = lot();
  const c = chained();
  const suelto = lot();
  assert.deepStrictEqual(ids(lockedLotIds([a, b, suelto, c])), [c.id]);
  assert.ok(!lockedLotIds([a, b, suelto, c]).has(suelto.id));
});

test("cada evento se calcula por separado", () => {
  const a = lot({ eventId: "e1" });
  const b = chained({ eventId: "e2", position: 0 }); // primero de su evento: cabeza
  assert.strictEqual(lockedLotIds([a, b]).size, 0);
});

test("VIP arriba + General 1 activos a la vez; General 2 y 3 esperan a General 1", () => {
  const [vip, g1, g2, g3] = [lot(), lot(), chained(), chained()];
  const lots = [vip, g1, g2, g3];
  assert.deepStrictEqual(ids(lockedLotIds(lots)), [g2.id, g3.id].sort()); // VIP y G1 en venta
  vip.ticketsAvailable = 0; // agotar el VIP no habilita nada de la cadena
  assert.deepStrictEqual(ids(lockedLotIds(lots)), [g2.id, g3.id].sort());
  g1.ticketsAvailable = 0;
  assert.deepStrictEqual(ids(lockedLotIds(lots)), [g3.id]); // G2 se habilita, G3 sigue esperando
});
