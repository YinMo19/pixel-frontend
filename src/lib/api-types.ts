export type RoomState = 'active' | 'archived' | 'closed';

export interface ApiErrorBody {
	code: string;
	message: string;
}

export interface Room {
	id: string;
	name: string;
	width: number;
	height: number;
	max_members: number;
	state: RoomState;
	last_seq: number;
	created_at: string;
	updated_at: string;
}

export interface PixelEvent {
	room_id: string;
	seq: number;
	actor_session_id: string;
	x: number;
	y: number;
	color: string;
	tool: 'pen' | 'eraser' | 'fill' | string;
	created_at: string;
}

export interface Snapshot {
	room_id: string;
	seq: number;
	encoding: 'raw_rgba' | string;
	payload_base64: string;
	updated_at: string;
}

export interface CreateRoomRequest {
	name: string;
	width: number;
	height: number;
	max_members?: number;
}

export interface CreateRoomResponse {
	room: Room;
}

export interface ListRoomsResponse {
	items: Room[];
	next_cursor: string | null;
}

export interface GetRoomResponse {
	room: Room;
}

export interface JoinRoomRequest {
	session_id: string;
	nickname: string;
	color: string;
}

export interface JoinRoomResponse {
	room_id: string;
	session_id: string;
	last_seq: number;
	ws_url: string;
}

export interface SnapshotResponse {
	snapshot: Snapshot | null;
	last_seq: number;
}

export interface EventDeltaResponse {
	room_id: string;
	from_seq: number;
	to_seq: number;
	items: PixelEvent[];
	has_more: boolean;
}

export interface WsEnvelope<TPayload = unknown> {
	type: string;
	ts?: string;
	request_id?: string;
	payload: TPayload;
}

export interface WsHelloPayload {
	room_id: string;
	session_id: string;
	last_seq: number;
}

export interface WsSyncDeltaPayload {
	from_seq: number;
	to_seq: number;
	items: PixelEvent[];
}

export interface WsPresencePayload {
	action: 'join' | 'leave' | 'update';
	session_id: string;
	nickname?: string;
	color?: string;
}

export interface WsCursorPayload {
	session_id: string;
	x: number;
	y: number;
}

export interface WsAckPayload {
	ok: boolean;
}

export interface WsErrorPayload {
	code: string;
	message: string;
}
