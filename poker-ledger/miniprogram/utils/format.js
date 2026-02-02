/**
 * 时间格式化工具：仅用于 UI 展示。
 */

/**
 * 把时间戳格式化为「MM-DD HH:mm」。
 *
 * @param {number} ts
 * @returns {string}
 */
function formatTime(ts) {
  const d = new Date(Number(ts) || 0);
  const pad2 = (n) => String(n).padStart(2, "0");

  const MM = pad2(d.getMonth() + 1);
  const DD = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  return `${MM}-${DD} ${hh}:${mm}`;
}

module.exports = {
  formatTime
};

