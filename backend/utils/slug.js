const { Op } = require("sequelize");

// "Fiesta de Verano 2026!" -> "fiesta-de-verano-2026"
const slugify = (text) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "evento";

/**
 * Slug único para un evento: el título, con -2, -3… si ya existe.
 * Es la parte final de la URL pública (/e/<slug>)
 */
const uniqueSlug = async (Event, title, ignoreId, transaction) => {
  const base = slugify(title);
  let slug = base;
  for (let n = 2; ; n++) {
    const where = { slug };
    if (ignoreId) where.id = { [Op.ne]: ignoreId };
    if (!(await Event.count({ where, transaction }))) return slug;
    slug = `${base}-${n}`;
  }
};

/** Les da slug a los eventos anteriores a las URLs propias. Idempotente */
const backfillSlugs = async (Event) => {
  const events = await Event.findAll({ where: { slug: null } });
  for (const event of events) {
    await event.update({ slug: await uniqueSlug(Event, event.title, event.id) });
  }
  return events.length;
};

module.exports = { slugify, uniqueSlug, backfillSlugs };
