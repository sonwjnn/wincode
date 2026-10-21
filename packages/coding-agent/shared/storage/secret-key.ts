const SECRET_KEY_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/u;

export const isValidSecretKey = (key: string): boolean =>
	SECRET_KEY_PATTERN.test(key);
