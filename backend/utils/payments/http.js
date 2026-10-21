// fetch con timeout y reintentos ante errores de red o 5xx, compartido por las
// pasarelas. Los errores 4xx no se reintentan; el error lleva `status`
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = async (url, options, what) => {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response.json();

      const detail = (await response.text().catch(() => "")).slice(0, 300);
      lastError = new Error(`${what} falló (HTTP ${response.status}) ${detail}`.trim());
      lastError.status = response.status;
      if (response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(300 * attempt);
  }
  throw lastError;
};

module.exports = { request };
