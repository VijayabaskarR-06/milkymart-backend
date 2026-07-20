// The business operates only in Patna. Patna district PIN codes start 800/801/
// 803/804/805 (Patna city is 800xxx). We validate the PIN in a delivery address
// and reject anything outside the service area — like Blinkit/Zepto do.
const PATNA_PIN_PREFIXES = ['800', '801', '803', '804', '805']

export const UNAVAILABLE_MESSAGE =
  "We're not available at this address yet. We're working hard to expand our reach to your area."

export function checkServiceArea(detail) {
  const text = String(detail || '')
  const pin = (text.match(/\b(\d{6})\b/) || [])[1]
  if (!pin) {
    return { ok: false, error: 'Please include a 6-digit pincode in your address.' }
  }
  if (!PATNA_PIN_PREFIXES.includes(pin.slice(0, 3))) {
    return { ok: false, error: UNAVAILABLE_MESSAGE, outOfArea: true }
  }
  return { ok: true }
}
