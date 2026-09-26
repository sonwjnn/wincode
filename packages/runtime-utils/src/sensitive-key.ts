const SENSITIVE_KEY_NAME_PATTERN =
	/(?:accesskey|apikey|auth|authorization|bearer|cookie|credential|passphrase|password|passwd|privatekey|secret|session|signature|token)/i;
const SENSITIVE_EXACT_KEY_PATTERN = /^(?:code|key|sig|state)$/i;
const SENSITIVE_SIGNATURE_KEY_PATTERN = /(?:^|[_-])sig(?:$|[_-])/i;

/** Whether a field name identifies a known credential or secret-bearing value. */
export const isSensitiveKey = (key: string): boolean => {
	const normalizedKey = key.replace(/[^a-z0-9]/gi, "");
	return (
		SENSITIVE_KEY_NAME_PATTERN.test(normalizedKey) ||
		SENSITIVE_EXACT_KEY_PATTERN.test(normalizedKey) ||
		SENSITIVE_SIGNATURE_KEY_PATTERN.test(key)
	);
};
