// utils/zarinpal.js
// ──────────────────────────────────────────────────────────
// اتصال به درگاه پرداخت زرین‌پال (Payment Request + Verify)
// مستندات: https://docs.zarinpal.com
// ──────────────────────────────────────────────────────────
const axios = require('axios');
require('dotenv').config();

const MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID || '';
const SANDBOX = (process.env.ZARINPAL_SANDBOX || 'true') === 'true';
const CALLBACK_URL = process.env.ZARINPAL_CALLBACK_URL || 'http://localhost:4000/api/payment/verify';

const BASE_URL = SANDBOX
  ? 'https://sandbox.zarinpal.com/pg/v4/payment'
  : 'https://payment.zarinpal.com/pg/v4/payment';

const STARTPAY_URL = SANDBOX
  ? 'https://sandbox.zarinpal.com/pg/StartPay/'
  : 'https://www.zarinpal.com/pg/StartPay/';

/**
 * درخواست پرداخت جدید به زرین‌پال
 * @param {number} amount - مقدار به تومان (زرین‌پال داخلش ضربدر ۱۰ میشه چون ریال می‌خواد)
 * @param {string} description
 * @param {object} meta - { mobile, email } اختیاری
 */
async function requestPayment(amount, description, meta = {}) {
  try {
    const { data } = await axios.post(`${BASE_URL}/request.json`, {
      merchant_id: MERCHANT_ID,
      amount: amount * 10, // تومان به ریال
      description,
      callback_url: CALLBACK_URL,
      metadata: meta
    }, { timeout: 10000 });

    if (data?.data?.code === 100) {
      return {
        success: true,
        authority: data.data.authority,
        payment_url: STARTPAY_URL + data.data.authority
      };
    }
    return { success: false, error: data?.errors?.message || 'خطای نامشخص از زرین‌پال' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * تایید پرداخت بعد از برگشت کاربر از زرین‌پال
 * @param {number} amount - باید دقیقا با amount درخواست اولیه برابر باشه (تومان)
 * @param {string} authority
 */
async function verifyPayment(amount, authority) {
  try {
    const { data } = await axios.post(`${BASE_URL}/verify.json`, {
      merchant_id: MERCHANT_ID,
      amount: amount * 10,
      authority
    }, { timeout: 10000 });

    // کد 100 = تایید موفق، کد 101 = قبلا تایید شده (هم موفق حساب میشه)
    if (data?.data?.code === 100 || data?.data?.code === 101) {
      return { success: true, ref_id: data.data.ref_id, code: data.data.code };
    }
    return { success: false, error: data?.errors?.message || 'پرداخت تایید نشد', code: data?.data?.code };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { requestPayment, verifyPayment };
