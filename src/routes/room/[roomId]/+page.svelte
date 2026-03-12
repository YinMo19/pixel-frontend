<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import type { PageProps } from './$types';
	import Brush from '@lucide/svelte/icons/brush';
	import Eraser from '@lucide/svelte/icons/eraser';
	import Pipette from '@lucide/svelte/icons/pipette';
	import Copy from '@lucide/svelte/icons/copy';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Grid2x2 from '@lucide/svelte/icons/grid-2x2';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Separator } from '$lib/components/ui/separator';
	import { Switch } from '$lib/components/ui/switch';
	import {
		buildWsUrlWithParams,
		getEventDelta,
		getRoom,
		getSnapshot,
		joinRoom,
		PixelRoomApiError,
		resolveWsUrl
	} from '$lib/api/pixel-room-client';
	import type {
		PixelEvent,
		Room,
		WsAckPayload,
		WsCursorPayload,
		WsEnvelope,
		WsErrorPayload,
		WsHelloPayload,
		WsPresencePayload,
		WsSyncDeltaPayload
	} from '$lib/api-types';
	import {
		createRandomRgbaColor,
		getOrCreateSessionId,
		getStoredProfile,
		isTransparentRgba,
		rgbToRgbaHex,
		rgbaToRgbHex,
		saveProfile
	} from '$lib/session';

	let { data }: PageProps = $props();

	type ToolMode = 'brush' | 'eraser' | 'picker';
	type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
	interface Member {
		session_id: string;
		nickname: string;
		color: string;
	}
	interface RemoteCursor {
		session_id: string;
		x: number;
		y: number;
		updated_at: number;
	}

	const palette = [
		'#0F172AFF',
		'#EF4444FF',
		'#F97316FF',
		'#EAB308FF',
		'#22C55EFF',
		'#06B6D4FF',
		'#3B82F6FF',
		'#8B5CF6FF'
	];

	let room = $state<Room | null>(null);
	let loading = $state(true);
	let loadingError = $state('');

	let toolMode = $state<ToolMode>('brush');
	let activeColor = $state('#3B82F6FF');
	let showGrid = $state(true);
	let zoomPercent = $state(100);
	let isDrawing = $state(false);
	let lastHoverIndex = $state<number | null>(null);

	let sessionId = $state('');
	let nickname = $state('游客');
	let profileColor = $state('#3B82F6FF');
	let joinWsUrl = $state('');
	let connectionStatus = $state<ConnectionStatus>('disconnected');
	let lastSeq = $state(0);
	let syncing = $state(false);
	let reconnectAttempt = $state(0);
	let reconnectCountdownMs = $state(0);

	let members = $state<Member[]>([]);
	let remoteCursors = $state<Record<string, RemoteCursor>>({});
	let activities = $state<string[]>(['系统：正在初始化房间连接...']);

	let pixels = $state<string[]>([]);
	const totalCells = $derived((room?.width ?? 1) * (room?.height ?? 1));
	const paintedCount = $derived(pixels.filter((item) => item !== 'transparent').length);
	const memberCount = $derived(members.length);
	const activeRemoteCursors = $derived.by(() => {
		return Object.values(remoteCursors).filter((cursor) => {
			if (cursor.session_id === sessionId) return false;
			return Date.now() - cursor.updated_at < 10_000;
		});
	});

	let ws: WebSocket | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectCountdownTimer: ReturnType<typeof setInterval> | null = null;
	let cursorCleanupTimer: ReturnType<typeof setInterval> | null = null;
	let requestCounter = 0;
	let lastCursorSentAt = 0;
	let lastCursorSentIndex: number | null = null;
	let destroyed = false;

	function toMessage(error: unknown) {
		if (error instanceof PixelRoomApiError) {
			return `${error.message} (${error.code})`;
		}
		if (error instanceof Error) return error.message;
		return '请求失败，请稍后重试';
	}

	function nextRequestId(prefix = 'req') {
		requestCounter += 1;
		return `${prefix}_${Date.now()}_${requestCounter}`;
	}

	function logActivity(message: string) {
		const time = new Date().toLocaleTimeString('zh-CN', {
			hour: '2-digit',
			minute: '2-digit'
		});
		activities = [`${time} · ${message}`, ...activities].slice(0, 14);
	}

	function indexByXY(x: number, y: number) {
		if (!room) return -1;
		if (x < 0 || y < 0 || x >= room.width || y >= room.height) return -1;
		return y * room.width + x;
	}

	function resetCanvas(width: number, height: number) {
		pixels = Array.from({ length: width * height }, () => 'transparent');
	}

	function eventColorToCanvasColor(event: PixelEvent) {
		if (event.tool === 'eraser') return 'transparent';
		const normalized = rgbToRgbaHex(event.color);
		if (isTransparentRgba(normalized)) return 'transparent';
		return normalized;
	}

	function applyDrawEvent(event: PixelEvent) {
		const index = indexByXY(event.x, event.y);
		if (index < 0) return;
		pixels[index] = eventColorToCanvasColor(event);
		lastSeq = Math.max(lastSeq, event.seq);
	}

	function decodeSnapshotRawRgba(payloadBase64: string, width: number, height: number) {
		const binary = atob(payloadBase64);
		const expectedPixels = width * height;
		const maxPixels = Math.min(expectedPixels, Math.floor(binary.length / 4));
		resetCanvas(width, height);

		for (let i = 0; i < maxPixels; i += 1) {
			const offset = i * 4;
			const r = binary.charCodeAt(offset);
			const g = binary.charCodeAt(offset + 1);
			const b = binary.charCodeAt(offset + 2);
			const a = binary.charCodeAt(offset + 3);
			if (a === 0) {
				pixels[i] = 'transparent';
				continue;
			}
			const rgba = `#${r.toString(16).padStart(2, '0')}${g
				.toString(16)
				.padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a
				.toString(16)
				.padStart(2, '0')}`.toUpperCase();
			pixels[i] = rgba;
		}
	}

	function upsertMember(member: Member) {
		const next = members.filter((item) => item.session_id !== member.session_id);
		next.push(member);
		members = next;
	}

	function removeMember(sessionIdToRemove: string) {
		members = members.filter((item) => item.session_id !== sessionIdToRemove);
	}

	function findMemberBySessionId(targetSessionId: string) {
		return members.find((item) => item.session_id === targetSessionId) ?? null;
	}

	function cursorDisplayName(targetSessionId: string) {
		if (targetSessionId === sessionId) return nickname;
		return findMemberBySessionId(targetSessionId)?.nickname ?? targetSessionId.slice(0, 8);
	}

	function cursorDisplayColor(targetSessionId: string) {
		if (targetSessionId === sessionId) return profileColor;
		return findMemberBySessionId(targetSessionId)?.color ?? '#3B82F6FF';
	}

	function setRemoteCursor(payload: WsCursorPayload) {
		if (payload.session_id === sessionId) return;
		if (payload.x < 0 || payload.y < 0) return;
		if (room && (payload.x >= room.width || payload.y >= room.height)) return;

		remoteCursors[payload.session_id] = {
			session_id: payload.session_id,
			x: payload.x,
			y: payload.y,
			updated_at: Date.now()
		};
	}

	function removeRemoteCursor(targetSessionId: string) {
		if (!remoteCursors[targetSessionId]) return;
		delete remoteCursors[targetSessionId];
		remoteCursors = { ...remoteCursors };
	}

	function cleanupStaleCursors() {
		const now = Date.now();
		let changed = false;
		for (const [cursorSessionId, cursor] of Object.entries(remoteCursors)) {
			if (now - cursor.updated_at > 10_000) {
				delete remoteCursors[cursorSessionId];
				changed = true;
			}
		}
		if (changed) {
			remoteCursors = { ...remoteCursors };
		}
	}

	function sendFrame<TPayload>(type: string, payload: TPayload, requestId?: string) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		const envelope: WsEnvelope<TPayload> = {
			type,
			request_id: requestId,
			payload
		};
		ws.send(JSON.stringify(envelope));
	}

	function requestSync(afterSeq: number) {
		sendFrame('sync_request', { after_seq: afterSeq }, nextRequestId('sync'));
	}

	function handleServerEnvelope(raw: string) {
		let envelope: WsEnvelope;
		try {
			envelope = JSON.parse(raw) as WsEnvelope;
		} catch {
			logActivity('收到无法解析的 WebSocket 消息');
			return;
		}

		switch (envelope.type) {
			case 'hello': {
				const payload = envelope.payload as WsHelloPayload;
				lastSeq = Math.max(lastSeq, payload.last_seq ?? 0);
				logActivity(`WS 已连接，当前序列 ${lastSeq}`);
				break;
			}
			case 'draw_commit': {
				const event = envelope.payload as PixelEvent;
				if (event.seq > lastSeq + 1) {
					logActivity(`检测到序列跳跃 (${lastSeq} -> ${event.seq})，发起补同步`);
					requestSync(lastSeq);
					return;
				}
				if (event.seq <= lastSeq) return;
				applyDrawEvent(event);
				break;
			}
			case 'sync_delta': {
				const payload = envelope.payload as WsSyncDeltaPayload;
				const ordered = [...(payload.items ?? [])].sort((a, b) => a.seq - b.seq);
				for (const event of ordered) {
					if (event.seq <= lastSeq) continue;
					applyDrawEvent(event);
				}
				if (ordered.length > 0) {
					logActivity(`补同步完成：${ordered.length} 条事件`);
				}
				break;
			}
			case 'presence': {
				const payload = envelope.payload as WsPresencePayload;
				if (payload.action === 'leave') {
					removeMember(payload.session_id);
					removeRemoteCursor(payload.session_id);
					logActivity(`${payload.session_id.slice(0, 8)} 离开房间`);
					break;
				}

				const nextMember = {
					session_id: payload.session_id,
					nickname: payload.nickname ?? payload.session_id.slice(0, 8),
					color: rgbToRgbaHex(payload.color ?? '#3B82F6')
				} satisfies Member;

				upsertMember(nextMember);
				if (payload.action === 'join') {
					logActivity(`${nextMember.nickname} 加入房间`);
				}
				break;
			}
			case 'cursor': {
				const payload = envelope.payload as WsCursorPayload;
				setRemoteCursor(payload);
				break;
			}
			case 'ack': {
				const payload = envelope.payload as WsAckPayload;
				if (!payload.ok) {
					logActivity('服务端返回 ack=false');
				}
				break;
			}
			case 'error': {
				const payload = envelope.payload as WsErrorPayload;
				logActivity(`服务端错误：${payload.message} (${payload.code})`);
				break;
			}
			default:
				break;
		}
	}

	function stopPingTimer() {
		if (pingTimer) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
	}

	function stopReconnectTimers() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (reconnectCountdownTimer) {
			clearInterval(reconnectCountdownTimer);
			reconnectCountdownTimer = null;
		}
		reconnectCountdownMs = 0;
	}

	function disconnectWs(options?: { permanent?: boolean }) {
		stopPingTimer();
		stopReconnectTimers();
		remoteCursors = {};
		if (ws) {
			const closingSocket = ws;
			ws = null;
			closingSocket.close();
		}
		if (options?.permanent) {
			reconnectAttempt = 0;
		}
		connectionStatus = 'disconnected';
	}

	function scheduleReconnect() {
		if (destroyed || !joinWsUrl || reconnectTimer) return;

		reconnectAttempt += 1;
		const baseDelay = Math.min(30_000, Math.round(1_000 * 2 ** (reconnectAttempt - 1)));
		const jitter = Math.floor(Math.random() * 500);
		const delay = baseDelay + jitter;

		connectionStatus = 'reconnecting';
		reconnectCountdownMs = delay;
		logActivity(`WebSocket 已断开，${Math.ceil(delay / 1000)} 秒后自动重连（第 ${reconnectAttempt} 次）`);

		if (reconnectCountdownTimer) {
			clearInterval(reconnectCountdownTimer);
		}
		reconnectCountdownTimer = setInterval(() => {
			reconnectCountdownMs = Math.max(0, reconnectCountdownMs - 500);
		}, 500);

		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (reconnectCountdownTimer) {
				clearInterval(reconnectCountdownTimer);
				reconnectCountdownTimer = null;
			}
			reconnectCountdownMs = 0;
			connectWs({ resetBackoff: false });
		}, delay);
	}

	function connectWs(options?: { resetBackoff?: boolean }) {
		if (!joinWsUrl) return;
		stopPingTimer();
		stopReconnectTimers();
		if (ws) {
			const closingSocket = ws;
			ws = null;
			closingSocket.close();
		}
		if (options?.resetBackoff !== false) {
			reconnectAttempt = 0;
		}

		const baseUrl = resolveWsUrl(joinWsUrl);
		const wsUrl = buildWsUrlWithParams(baseUrl, {
			nickname,
			color: profileColor,
			last_seen_seq: lastSeq
		});

		connectionStatus = 'connecting';
		const socket = new WebSocket(wsUrl);
		ws = socket;

		socket.onopen = () => {
			if (socket !== ws) return;
			stopReconnectTimers();
			reconnectAttempt = 0;
			connectionStatus = 'connected';
			requestSync(lastSeq);
			logActivity('WebSocket 连接已建立');
			pingTimer = setInterval(() => {
				sendFrame('ping', {}, nextRequestId('ping'));
			}, 20_000);
		};

		socket.onmessage = (event) => {
			if (socket !== ws) return;
			if (typeof event.data === 'string') {
				handleServerEnvelope(event.data);
			}
		};

		socket.onerror = () => {
			if (socket !== ws) return;
			logActivity('WebSocket 出现错误');
		};

		socket.onclose = () => {
			if (socket !== ws) return;
			stopPingTimer();
			ws = null;
			connectionStatus = 'disconnected';
			if (!destroyed) scheduleReconnect();
		};
	}

	async function hydrateFromHttp() {
		if (!room) return;
		syncing = true;
		try {
			const snapshotResp = await getSnapshot(room.id);
			let cursor = 0;
			if (snapshotResp.snapshot && snapshotResp.snapshot.encoding === 'raw_rgba') {
				decodeSnapshotRawRgba(snapshotResp.snapshot.payload_base64, room.width, room.height);
				cursor = snapshotResp.snapshot.seq;
			} else {
				resetCanvas(room.width, room.height);
			}

			for (let i = 0; i < 12; i += 1) {
				const delta = await getEventDelta(room.id, {
					afterSeq: cursor,
					limit: 1000
				});
				const ordered = [...delta.items].sort((a, b) => a.seq - b.seq);
				for (const event of ordered) {
					if (event.seq <= cursor) continue;
					applyDrawEvent(event);
					cursor = event.seq;
				}
				if (!delta.has_more) {
					cursor = Math.max(cursor, delta.to_seq);
					break;
				}
			}
			lastSeq = cursor;
			logActivity(`HTTP 同步完成，当前序列 ${lastSeq}`);
		} finally {
			syncing = false;
		}
	}

	async function bootstrapRoom() {
		loading = true;
		loadingError = '';
		disconnectWs({ permanent: true });
		try {
			const profile = getStoredProfile();
			sessionId = getOrCreateSessionId();
			nickname = data.initialNickname || profile.nickname || `guest_${sessionId.slice(0, 8)}`;
			profileColor = rgbToRgbaHex(data.initialColor || profile.color || createRandomRgbaColor());
			activeColor = profileColor;
			saveProfile({ nickname, color: profileColor });

			const roomResp = await getRoom(data.roomId);
			room = roomResp.room;
			members = [];
			remoteCursors = {};
			resetCanvas(room.width, room.height);

			const joinResp = await joinRoom(room.id, {
				session_id: sessionId,
				nickname,
				color: profileColor
			});
			joinWsUrl = joinResp.ws_url;
			lastSeq = Math.max(0, joinResp.last_seq);

			upsertMember({
				session_id: sessionId,
				nickname,
				color: profileColor
			});

			await hydrateFromHttp();
			connectWs();
		} catch (error) {
			loadingError = toMessage(error);
			logActivity(`初始化失败：${loadingError}`);
		} finally {
			loading = false;
		}
	}

	function paintByIndex(index: number) {
		if (!room) return;
		if (toolMode === 'picker') {
			const picked = pixels[index];
			if (picked !== 'transparent') {
				activeColor = rgbToRgbaHex(picked);
				toolMode = 'brush';
				logActivity(`取色成功：${activeColor}`);
			}
			return;
		}

		if (!ws || ws.readyState !== WebSocket.OPEN) {
			logActivity('WebSocket 未连接，无法发送绘制');
			return;
		}

		const x = index % room.width;
		const y = Math.floor(index / room.width);
		const tool = toolMode === 'eraser' ? 'eraser' : 'pen';
		const color = toolMode === 'eraser' ? '#00000000' : rgbToRgbaHex(activeColor);
		sendFrame(
			'draw',
			{
				x,
				y,
				color,
				tool
			},
			nextRequestId('draw')
		);
	}

	function emitCursorFromIndex(index: number) {
		if (!room || !ws || ws.readyState !== WebSocket.OPEN) return;
		const now = Date.now();
		if (lastCursorSentIndex === index && now - lastCursorSentAt < 120) return;
		if (now - lastCursorSentAt < 60) return;
		lastCursorSentAt = now;
		lastCursorSentIndex = index;

		const x = index % room.width;
		const y = Math.floor(index / room.width);
		sendFrame('cursor', { x, y });
	}

	function beginDrawing(index: number, event: PointerEvent) {
		event.preventDefault();
		isDrawing = true;
		lastHoverIndex = index;
		emitCursorFromIndex(index);
		paintByIndex(index);
	}

	function handleCellPointerEnter(index: number) {
		emitCursorFromIndex(index);
		if (!isDrawing) return;
		if (lastHoverIndex === index) return;
		lastHoverIndex = index;
		paintByIndex(index);
	}

	function endDrawing() {
		isDrawing = false;
		lastHoverIndex = null;
	}

	function chooseColor(color: string) {
		activeColor = rgbToRgbaHex(color);
		if (toolMode === 'picker') {
			toolMode = 'brush';
		}
	}

	async function copyRoomCode() {
		if (!room) return;
		await navigator.clipboard.writeText(room.id);
		logActivity(`已复制房间 ID：${room.id}`);
	}

	async function leaveRoom() {
		disconnectWs({ permanent: true });
		await goto('/');
	}

	onMount(() => {
		cursorCleanupTimer = setInterval(() => {
			cleanupStaleCursors();
		}, 2_000);
		void bootstrapRoom();
	});

	onDestroy(() => {
		destroyed = true;
		if (cursorCleanupTimer) {
			clearInterval(cursorCleanupTimer);
			cursorCleanupTimer = null;
		}
		disconnectWs({ permanent: true });
	});
</script>

<svelte:window onpointerup={endDrawing} onpointercancel={endDrawing} />

<div class="min-h-screen bg-muted/30">
	<main class="mx-auto flex w-full max-w-[1500px] flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
		{#if loadingError}
			<div class="rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
				<p class="font-medium">房间初始化失败</p>
				<p class="mt-1">{loadingError}</p>
				<div class="mt-3">
					<Button size="sm" variant="outline" onclick={bootstrapRoom}>重试</Button>
				</div>
			</div>
		{/if}

		<header class="rounded-xl border bg-card p-4 shadow-sm md:p-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="space-y-2">
					<div class="flex flex-wrap items-center gap-2">
						<h1 class="text-xl font-semibold">{room?.name ?? data.roomId}</h1>
						<Badge>{room?.id ?? data.roomId}</Badge>
						{#if room}
							<Badge variant="secondary">{room.width}×{room.height}</Badge>
						{/if}
							<Badge
								variant={connectionStatus === 'connected'
									? 'default'
									: connectionStatus === 'reconnecting'
										? 'destructive'
										: 'secondary'}
							>
								WS {connectionStatus}
							</Badge>
						</div>
						<p class="text-sm text-muted-foreground">
							昵称 {nickname} · 在线 {memberCount} 人 · 当前序列 {lastSeq}
							{#if connectionStatus === 'reconnecting'}
								· {Math.max(1, Math.ceil(reconnectCountdownMs / 1000))} 秒后重连
							{/if}
						</p>
					</div>

				<div class="flex flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" onclick={copyRoomCode} disabled={!room}>
						<Copy class="size-4" />
						复制房间码
					</Button>
						<Button
							variant="outline"
							size="sm"
							onclick={() => {
								connectWs({ resetBackoff: true });
							}}
							disabled={!room}
						>
							<RotateCw class="size-4" />
							重连 WS
						</Button>
					<Button variant="ghost" size="sm" onclick={leaveRoom}>
						<LogOut class="size-4" />
						离开
					</Button>
				</div>
			</div>
		</header>

		<section class="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)_280px]">
			<aside class="space-y-4">
				<Card>
					<CardHeader>
						<CardTitle class="text-base">工具栏</CardTitle>
						<CardDescription>`draw` 消息会由服务端广播 `draw_commit`</CardDescription>
					</CardHeader>
					<CardContent class="space-y-2">
						<Button
							class="w-full justify-start"
							variant={toolMode === 'brush' ? 'default' : 'outline'}
							onclick={() => {
								toolMode = 'brush';
							}}
						>
							<Brush class="size-4" />
							画笔
						</Button>
						<Button
							class="w-full justify-start"
							variant={toolMode === 'eraser' ? 'default' : 'outline'}
							onclick={() => {
								toolMode = 'eraser';
							}}
						>
							<Eraser class="size-4" />
							橡皮擦
						</Button>
						<Button
							class="w-full justify-start"
							variant={toolMode === 'picker' ? 'default' : 'outline'}
							onclick={() => {
								toolMode = 'picker';
							}}
						>
							<Pipette class="size-4" />
							取色器
						</Button>
						<Separator class="my-3" />
						<Button class="w-full justify-start" variant="outline" onclick={hydrateFromHttp} disabled={syncing || !room}>
							<RefreshCw class={`size-4 ${syncing ? 'animate-spin' : ''}`} />
							{syncing ? '同步中...' : 'HTTP 重同步'}
						</Button>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle class="text-base">颜色面板</CardTitle>
						<CardDescription>当前颜色：{activeColor}</CardDescription>
					</CardHeader>
					<CardContent class="space-y-4">
						<div class="grid grid-cols-4 gap-2">
							{#each palette as color}
								<button
									type="button"
									class="h-8 rounded-md border transition"
									style={`background-color: ${color}`}
									title={color}
									onclick={() => {
										chooseColor(color);
									}}
									class:ring-2={activeColor === color}
									class:ring-primary={activeColor === color}
								></button>
							{/each}
						</div>

						<div class="space-y-2">
							<Label for="custom-color">自定义颜色</Label>
							<div class="flex items-center gap-2">
								<input
									id="custom-color"
									type="color"
									value={rgbaToRgbHex(activeColor)}
									class="h-9 w-14 cursor-pointer rounded-md border bg-transparent p-1"
									oninput={(event) => {
										chooseColor((event.currentTarget as HTMLInputElement).value);
									}}
								/>
								<Input value={activeColor} readonly class="font-mono text-xs" />
							</div>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle class="text-base">画布设置</CardTitle>
					</CardHeader>
					<CardContent class="space-y-4">
						<div class="flex items-center justify-between gap-2">
							<div class="flex items-center gap-2 text-sm">
								<Grid2x2 class="size-4" />
								显示网格
							</div>
							<Switch bind:checked={showGrid} aria-label="切换网格显示" />
						</div>

						<div class="space-y-2">
							<div class="flex items-center justify-between text-sm">
								<span class="inline-flex items-center gap-1"><ZoomIn class="size-4" /> 缩放</span>
								<span class="font-medium">{zoomPercent}%</span>
							</div>
							<input
								type="range"
								min="60"
								max="180"
								step="10"
								bind:value={zoomPercent}
								class="w-full"
							/>
						</div>
					</CardContent>
				</Card>
			</aside>

			<Card class="py-4">
				<CardHeader class="px-4 md:px-6">
					<CardTitle class="text-base">共享画布</CardTitle>
					<CardDescription>
						{#if room}
							已绘制 {paintedCount}/{totalCells} 个像素 · 当前工具：{toolMode}
						{:else}
							加载中...
						{/if}
					</CardDescription>
				</CardHeader>
				<CardContent class="px-4 md:px-6">
					<div class="overflow-auto rounded-xl border bg-background p-4">
						{#if room}
							<div class="mx-auto w-fit origin-top" style={`transform: scale(${zoomPercent / 100});`}>
								<div class="relative" style={`width: ${room.width * 18}px; height: ${room.height * 18}px;`}>
									<div
										class="grid touch-none select-none"
										style={`grid-template-columns: repeat(${room.width}, minmax(0, 1fr)); width: ${room.width * 18}px;`}
									>
										{#each pixels as color, index}
											<button
												type="button"
												class={`h-[18px] w-[18px] ${
													showGrid ? 'border border-border/70' : ''
												} ${color === 'transparent' ? 'bg-background' : ''}`}
												style={`background-color: ${color === 'transparent' ? 'transparent' : color};`}
												aria-label={`像素 ${index + 1}`}
												onpointerdown={(event) => {
													beginDrawing(index, event);
												}}
												onpointerenter={() => {
													handleCellPointerEnter(index);
												}}
												onpointerup={endDrawing}
											></button>
										{/each}
									</div>

									<div class="pointer-events-none absolute inset-0 z-10">
										{#each activeRemoteCursors as cursor (cursor.session_id)}
											{@const memberName = cursorDisplayName(cursor.session_id)}
											{@const memberColor = cursorDisplayColor(cursor.session_id)}
											<div
												class="absolute -translate-x-1/2 -translate-y-1/2"
												style={`left: ${(cursor.x + 0.5) * 18}px; top: ${(cursor.y + 0.5) * 18}px;`}
											>
												<div
													class="size-2 rounded-full border border-white shadow-sm"
													style={`background-color: ${memberColor};`}
												></div>
												<div
													class="mt-1 max-w-20 truncate rounded-sm border bg-background/90 px-1 py-0.5 text-[9px] text-foreground shadow"
												>
													{memberName}
												</div>
											</div>
										{/each}
									</div>
								</div>
							</div>
						{:else}
							<p class="text-sm text-muted-foreground">正在加载房间信息...</p>
						{/if}
					</div>
				</CardContent>
			</Card>

			<aside class="space-y-4">
				<Card>
					<CardHeader>
						<CardTitle class="text-base">房间成员</CardTitle>
						<CardDescription>`presence` 事件驱动实时在线列表</CardDescription>
					</CardHeader>
					<CardContent class="space-y-3">
						{#if members.length === 0}
							<p class="text-sm text-muted-foreground">暂无成员信息</p>
						{:else}
							{#each members as member}
								<div class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
									<div class="flex items-center gap-3">
										<Avatar>
											<AvatarFallback>{member.nickname.slice(0, 2).toUpperCase()}</AvatarFallback>
										</Avatar>
										<div>
											<p class="text-sm font-medium">{member.nickname}</p>
											<p class="text-xs text-muted-foreground font-mono">{member.session_id.slice(0, 12)}</p>
										</div>
									</div>
									<Badge variant="secondary" class="font-mono text-[10px]">{member.color}</Badge>
								</div>
							{/each}
						{/if}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle class="text-base">操作记录</CardTitle>
						<CardDescription>HTTP + WS 关键事件日志</CardDescription>
					</CardHeader>
					<CardContent class="space-y-2">
						{#each activities as item}
							<p class="rounded-md border px-3 py-2 text-xs text-muted-foreground">{item}</p>
						{/each}
					</CardContent>
				</Card>
			</aside>
		</section>
	</main>
</div>
