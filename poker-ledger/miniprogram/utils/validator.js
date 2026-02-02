const CONST = require("./const");

/**
 * 将输入转为「非负整数」字符串（用于输入框回显）。
 * - 只保留数字
 * - 去掉前导 0（保留单个 0）
 *
 * @param {string} raw
 * @returns {string}
 */
function toUnsignedIntText(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  return String(parseInt(digits, 10));
}

/**
 * 校验房间号（短码+字母，统一转大写）。
 *
 * @param {string} code
 * @returns {{ok: boolean, code: string, message: string}}
 */
function validateRoomCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return { ok: false, code: "", message: "请输入房间号" };
  if (normalized.length < 4) return { ok: false, code: "", message: "房间号太短" };
  if (!/^[0-9A-Z]+$/.test(normalized)) {
    return { ok: false, code: "", message: "房间号仅支持数字和大写字母" };
  }
  return { ok: true, code: normalized, message: "" };
}

/**
 * 校验转账金额（正整数）。
 *
 * @param {any} v
 * @returns {{ok: boolean, amount: number, message: string}}
 */
function validateAmount(v) {
  const amount = Number(v);
  if (!Number.isInteger(amount)) return { ok: false, amount: 0, message: "金额必须为整数" };
  if (amount < CONST.AMOUNT_MIN) return { ok: false, amount: 0, message: "金额必须大于 0" };
  if (amount > CONST.AMOUNT_MAX) return { ok: false, amount: 0, message: "金额过大" };
  return { ok: true, amount, message: "" };
}

module.exports = {
  toUnsignedIntText,
  validateRoomCode,
  validateAmount
};

