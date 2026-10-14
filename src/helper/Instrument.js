const isValidInstrumentId = (mode, instrumentId) => {
  if (!instrumentId || instrumentId.length < 6) return false;

  const commonPattern = /^[A-Za-z0-9@_-]+$/;
  if (!commonPattern.test(instrumentId)) return false;

  const modePatterns = {
    UPI: /@|upi/i,
    BANK: /neft|imps|rtgs|utr/i,
    CARD: /card|visa|master/i,
    CHEQUE: /chq|cheque/i
  };

  return modePatterns[mode]
    ? modePatterns[mode].test(instrumentId)
    : false;
};

module.exports = isValidInstrumentId;