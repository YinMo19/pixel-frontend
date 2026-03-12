const SESSION_KEY = 'pixel_party_session_id_v1';
const PROFILE_KEY = 'pixel_party_profile_v1';

export interface UserProfile {
	nickname: string;
	color: string;
}

function randomHexColorRgb() {
	const value = Math.floor(Math.random() * 0xffffff)
		.toString(16)
		.padStart(6, '0');
	return `#${value.toUpperCase()}`;
}

export function rgbToRgbaHex(color: string, alpha = 'FF') {
	const normalized = color.trim().toUpperCase();
	if (/^#[0-9A-F]{8}$/.test(normalized)) return normalized;
	if (/^#[0-9A-F]{6}$/.test(normalized)) return `${normalized}${alpha}`;
	return '#000000FF';
}

export function rgbaToRgbHex(color: string) {
	const normalized = color.trim().toUpperCase();
	if (/^#[0-9A-F]{8}$/.test(normalized)) return normalized.slice(0, 7);
	if (/^#[0-9A-F]{6}$/.test(normalized)) return normalized;
	return '#000000';
}

export function isTransparentRgba(color: string) {
	const normalized = color.trim().toUpperCase();
	if (!/^#[0-9A-F]{8}$/.test(normalized)) return false;
	return normalized.endsWith('00');
}

export function getOrCreateSessionId() {
	if (typeof window === 'undefined') return crypto.randomUUID();

	const storage = typeof sessionStorage !== 'undefined' ? sessionStorage : localStorage;
	const existing = storage.getItem(SESSION_KEY);
	if (existing && existing.trim()) return existing;
	const created = crypto.randomUUID();
	storage.setItem(SESSION_KEY, created);
	return created;
}

export function getStoredProfile() {
	if (typeof localStorage === 'undefined') {
		return {
			nickname: '',
			color: '#3B82F6FF'
		} satisfies UserProfile;
	}

	const raw = localStorage.getItem(PROFILE_KEY);
	if (!raw) {
		return {
			nickname: '',
			color: '#3B82F6FF'
		} satisfies UserProfile;
	}

	try {
		const parsed = JSON.parse(raw) as Partial<UserProfile>;
		return {
			nickname: parsed.nickname?.trim() ?? '',
			color: rgbToRgbaHex(parsed.color ?? '#3B82F6')
		} satisfies UserProfile;
	} catch {
		return {
			nickname: '',
			color: '#3B82F6FF'
		} satisfies UserProfile;
	}
}

export function saveProfile(profile: UserProfile) {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(
		PROFILE_KEY,
		JSON.stringify({
			nickname: profile.nickname,
			color: rgbToRgbaHex(profile.color)
		})
	);
}

export function createRandomRgbaColor() {
	return rgbToRgbaHex(randomHexColorRgb());
}
