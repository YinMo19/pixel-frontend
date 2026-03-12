import { env } from '$env/dynamic/public';
import type {
	ApiErrorBody,
	CreateRoomRequest,
	CreateRoomResponse,
	EventDeltaResponse,
	GetRoomResponse,
	JoinRoomRequest,
	JoinRoomResponse,
	ListRoomsResponse,
	RoomState,
	SnapshotResponse
} from '$lib/api-types';

export class PixelRoomApiError extends Error {
	status: number;
	code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'PixelRoomApiError';
		this.status = status;
		this.code = code;
	}
}

const apiBase = env.PUBLIC_API_BASE_URL || '/api/v1';
const wsBase = env.PUBLIC_WS_BASE_URL || '/ws/v1';

function withQuery(path: string, query: Record<string, string | number | undefined | null>) {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === '') continue;
		search.set(key, String(value));
	}
	const qs = search.toString();
	return qs ? `${path}?${qs}` : path;
}

async function request<TResponse>(path: string, init?: RequestInit): Promise<TResponse> {
	const response = await fetch(`${apiBase}${path}`, {
		...init,
		headers: {
			'content-type': 'application/json',
			...(init?.headers ?? {})
		}
	});

	if (!response.ok) {
		let body: ApiErrorBody | null = null;
		try {
			body = (await response.json()) as ApiErrorBody;
		} catch {
			// ignore non-json error body
		}
		throw new PixelRoomApiError(
			response.status,
			body?.code ?? 'http_error',
			body?.message ?? `HTTP ${response.status}`
		);
	}

	if (response.status === 204) {
		return undefined as TResponse;
	}

	return (await response.json()) as TResponse;
}

export async function createRoom(input: CreateRoomRequest) {
	return request<CreateRoomResponse>('/rooms', {
		method: 'POST',
		body: JSON.stringify(input)
	});
}

export async function listRooms(params?: {
	state?: RoomState;
	limit?: number;
	cursor?: string;
}) {
	return request<ListRoomsResponse>(
		withQuery('/rooms', {
			state: params?.state,
			limit: params?.limit,
			cursor: params?.cursor
		})
	);
}

export async function getRoom(roomId: string) {
	return request<GetRoomResponse>(`/rooms/${encodeURIComponent(roomId)}`);
}

export async function joinRoom(roomId: string, input: JoinRoomRequest) {
	return request<JoinRoomResponse>(`/rooms/${encodeURIComponent(roomId)}/join`, {
		method: 'POST',
		body: JSON.stringify(input)
	});
}

export async function getSnapshot(roomId: string) {
	return request<SnapshotResponse>(`/rooms/${encodeURIComponent(roomId)}/snapshot`);
}

export async function getEventDelta(roomId: string, input: { afterSeq: number; limit?: number }) {
	return request<EventDeltaResponse>(
		withQuery(`/rooms/${encodeURIComponent(roomId)}/events`, {
			after_seq: input.afterSeq,
			limit: input.limit
		})
	);
}

export function resolveWsUrl(wsUrl: string) {
	if (wsUrl.startsWith('ws://') || wsUrl.startsWith('wss://')) return wsUrl;

	if (wsUrl.startsWith('/')) {
		if (wsBase.startsWith('ws://') || wsBase.startsWith('wss://')) {
			return new URL(wsUrl, wsBase).toString();
		}
		if (typeof window !== 'undefined') {
			const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
			return new URL(wsUrl, `${protocol}//${window.location.host}`).toString();
		}
	}

	return wsUrl;
}

export function buildWsUrlWithParams(
	baseUrl: string,
	params: Record<string, string | number | undefined | null>
) {
	const url = new URL(baseUrl);
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === '') continue;
		url.searchParams.set(key, String(value));
	}
	return url.toString();
}
