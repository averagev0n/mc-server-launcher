// Отдельный поток для карты: разбор регионов не тормозит окно и консоль.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const { render } = require('./maprender');

parentPort.on('message', ({ id, file, scale }) => {
  try {
    const { size, rgba } = render(fs.readFileSync(file), scale);
    parentPort.postMessage({ id, size, rgba }, [rgba.buffer]);
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
