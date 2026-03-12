<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import Wifi from '@lucide/svelte/icons/wifi';
	import DoorOpen from '@lucide/svelte/icons/door-open';
	import Paintbrush from '@lucide/svelte/icons/paintbrush';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Users from '@lucide/svelte/icons/users';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardFooter,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { createRoom, listRooms, PixelRoomApiError } from '$lib/api/pixel-room-client';
	import type { Room } from '$lib/api-types';
	import { getStoredProfile, rgbToRgbaHex, rgbaToRgbHex, saveProfile } from '$lib/session';

	type CanvasPreset = 16 | 24 | 32 | 48 | 64;

	const canvasPresets: { label: string; value: CanvasPreset; description: string }[] = [
		{ label: '16 × 16', value: 16, description: '快速涂鸦，适合破冰' },
		{ label: '24 × 24', value: 24, description: '默认推荐，细节与速度平衡' },
		{ label: '32 × 32', value: 32, description: '中高精度，协作更有趣' },
		{ label: '48 × 48', value: 48, description: '高精度草图，适合协作作品' },
		{ label: '64 × 64', value: 64, description: '大画布，后续适配分层' }
	];

	const featureCards = [
		{
			title: '实时协作',
			desc: '按 API 文档接入 HTTP + WebSocket，和后端直接联调。',
			icon: Wifi
		},
		{
			title: '像素化创作',
			desc: '房间内共享画布，绘制操作走 `draw` / `draw_commit` 流程。',
			icon: Paintbrush
		},
		{
			title: '房间大厅',
			desc: '支持创建、加入和拉取活跃房间列表。',
			icon: Users
		}
	];

	let roomName = $state('像素派对房间');
	let nickname = $state('');
	let selectedCanvas = $state<CanvasPreset>(24);
	let maxMembers = $state(32);
	let colorRgb = $state('#3b82f6');

	let joinCode = $state('');
	let joinNickname = $state('');
	let joinColorRgb = $state('#3b82f6');

	let creating = $state(false);
	let formError = $state('');

	let rooms = $state<Room[]>([]);
	let roomsLoading = $state(false);
	let roomsError = $state('');

	function toMessage(error: unknown) {
		if (error instanceof PixelRoomApiError) {
			return `${error.message} (${error.code})`;
		}
		if (error instanceof Error) return error.message;
		return '请求失败，请稍后重试';
	}

	function persistProfile(nextNickname: string, nextColorRgb: string) {
		saveProfile({
			nickname: nextNickname,
			color: rgbToRgbaHex(nextColorRgb)
		});
	}

	async function refreshRooms() {
		roomsLoading = true;
		roomsError = '';
		try {
			const response = await listRooms({ state: 'active', limit: 20 });
			rooms = response.items;
		} catch (error) {
			roomsError = toMessage(error);
		} finally {
			roomsLoading = false;
		}
	}

	onMount(() => {
		const profile = getStoredProfile();
		nickname = profile.nickname;
		joinNickname = profile.nickname;
		colorRgb = rgbaToRgbHex(profile.color);
		joinColorRgb = rgbaToRgbHex(profile.color);
		void refreshRooms();
	});

	async function handleCreateRoom(event: SubmitEvent) {
		event.preventDefault();
		formError = '';
		creating = true;
		const normalizedNickname = nickname.trim() || '游客';
		const rgbaColor = rgbToRgbaHex(colorRgb);

		try {
			const response = await createRoom({
				name: roomName.trim() || '未命名房间',
				width: selectedCanvas,
				height: selectedCanvas,
				max_members: maxMembers
			});
			persistProfile(normalizedNickname, colorRgb);

			const params = new URLSearchParams({
				nickname: normalizedNickname,
				color: rgbaColor
			});
			await goto(`/room/${response.room.id}?${params.toString()}`);
		} catch (error) {
			formError = toMessage(error);
		} finally {
			creating = false;
		}
	}

	async function handleJoinRoom(event: SubmitEvent) {
		event.preventDefault();
		const roomId = joinCode.trim();
		if (!roomId) return;
		const normalizedNickname = joinNickname.trim() || '游客';
		const rgbaColor = rgbToRgbaHex(joinColorRgb);
		persistProfile(normalizedNickname, joinColorRgb);
		const params = new URLSearchParams({
			nickname: normalizedNickname,
			color: rgbaColor
		});
		await goto(`/room/${encodeURIComponent(roomId)}?${params.toString()}`);
	}

	function quickJoin(roomId: string) {
		joinCode = roomId;
	}
</script>

<div class="min-h-screen bg-muted/30">
	<main class="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 md:px-8">
		<section class="rounded-2xl border bg-card p-6 shadow-sm md:p-8">
			<div class="flex flex-wrap items-center gap-3">
				<Badge>API v1 Connected</Badge>
				<Badge variant="secondary">Svelte + Tailwind + shadcn-svelte</Badge>
			</div>
			<div class="mt-4 space-y-3">
				<h1 class="text-3xl font-bold tracking-tight md:text-4xl">Pixel Party 协作像素画</h1>
				<p class="max-w-3xl text-sm text-muted-foreground md:text-base">
					已按 API 文档接入房间创建/加入/拉取列表。进入房间后会走 join、snapshot、events、WS
					实时同步流程。
				</p>
			</div>
		</section>

		<section class="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
			<Card>
				<CardHeader>
					<CardTitle class="flex items-center gap-2 text-xl">
						<Sparkles class="size-5" />
						创建协作房间
					</CardTitle>
					<CardDescription>调用 `POST /api/v1/rooms` 创建房间。</CardDescription>
				</CardHeader>
				<CardContent>
					<form class="space-y-5" onsubmit={handleCreateRoom}>
						<div class="space-y-2">
							<Label for="room-name">房间名</Label>
							<Input
								id="room-name"
								bind:value={roomName}
								maxlength={40}
								placeholder="例如：周四晚上的像素夜"
								required
							/>
						</div>

						<div class="grid gap-4 sm:grid-cols-2">
							<div class="space-y-2">
								<Label for="nickname">你的昵称</Label>
								<Input id="nickname" bind:value={nickname} maxlength={20} placeholder="例如：Mo" />
							</div>
							<div class="space-y-2">
								<Label for="max-members">最大人数</Label>
								<Input id="max-members" type="number" bind:value={maxMembers} min={2} max={512} />
							</div>
						</div>

						<div class="space-y-2">
							<Label for="host-color">你的展示色</Label>
							<div class="flex items-center gap-2">
								<input
									id="host-color"
									type="color"
									bind:value={colorRgb}
									class="h-9 w-14 cursor-pointer rounded-md border bg-transparent p-1"
								/>
								<Input value={rgbToRgbaHex(colorRgb)} readonly class="font-mono text-xs" />
							</div>
						</div>

						<div class="space-y-2">
							<Label>画布尺寸</Label>
							<div class="grid gap-2 sm:grid-cols-2">
								{#each canvasPresets as preset}
									<button
										type="button"
										onclick={() => {
											selectedCanvas = preset.value;
										}}
										class={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition hover:bg-accent ${
											selectedCanvas === preset.value ? 'border-primary ring-2 ring-primary/20' : ''
										}`}
									>
										<div>
											<p class="text-sm font-medium">{preset.label}</p>
											<p class="text-xs text-muted-foreground">{preset.description}</p>
										</div>
										{#if selectedCanvas === preset.value}
											<Badge>已选</Badge>
										{/if}
									</button>
								{/each}
							</div>
						</div>

						{#if formError}
							<p class="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
								{formError}
							</p>
						{/if}

						<Button type="submit" class="w-full" size="lg" disabled={creating}>
							{creating ? '创建中...' : '创建并进入房间'}
						</Button>
					</form>
				</CardContent>
			</Card>

			<div class="space-y-6">
				<Card>
					<CardHeader>
						<CardTitle class="flex items-center gap-2 text-lg">
							<DoorOpen class="size-5" />
							加入已有房间
						</CardTitle>
						<CardDescription>输入房间 ID，进入后自动调用 join 接口。</CardDescription>
					</CardHeader>
					<CardContent>
						<form class="space-y-4" onsubmit={handleJoinRoom}>
							<div class="space-y-2">
								<Label for="join-code">房间 ID</Label>
								<Input
									id="join-code"
									bind:value={joinCode}
									placeholder="例如：room_01HV..."
									required
								/>
							</div>
							<div class="space-y-2">
								<Label for="join-name">昵称</Label>
								<Input id="join-name" bind:value={joinNickname} maxlength={20} placeholder="游客" />
							</div>
							<div class="space-y-2">
								<Label for="join-color">展示色</Label>
								<div class="flex items-center gap-2">
									<input
										id="join-color"
										type="color"
										bind:value={joinColorRgb}
										class="h-9 w-14 cursor-pointer rounded-md border bg-transparent p-1"
									/>
									<Input value={rgbToRgbaHex(joinColorRgb)} readonly class="font-mono text-xs" />
								</div>
							</div>
							<Button type="submit" class="w-full" variant="secondary">加入房间</Button>
						</form>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<div class="flex items-center justify-between gap-2">
							<div>
								<CardTitle class="text-lg">活跃房间</CardTitle>
								<CardDescription>来自 `GET /api/v1/rooms?state=active`</CardDescription>
							</div>
							<Button variant="outline" size="icon" onclick={refreshRooms} disabled={roomsLoading}>
								<RefreshCw class={`size-4 ${roomsLoading ? 'animate-spin' : ''}`} />
							</Button>
						</div>
					</CardHeader>
					<CardContent class="space-y-3">
						{#if roomsError}
							<p class="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
								{roomsError}
							</p>
						{:else if roomsLoading}
							<p class="text-sm text-muted-foreground">加载中...</p>
						{:else if rooms.length === 0}
							<p class="text-sm text-muted-foreground">暂无活跃房间，可以先创建一个。</p>
						{:else}
							{#each rooms as room}
								<div class="rounded-lg border p-3">
									<div class="flex items-start justify-between gap-2">
										<div>
											<p class="text-sm font-medium">{room.name}</p>
											<p class="text-xs text-muted-foreground">
												{room.id} · {room.width}×{room.height} · seq {room.last_seq}
											</p>
										</div>
										<Button size="sm" variant="outline" onclick={() => quickJoin(room.id)}>填入</Button>
									</div>
								</div>
							{/each}
						{/if}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle class="text-lg">当前阶段说明</CardTitle>
						<CardDescription>接口已按文档接入，后续继续增强编辑体验。</CardDescription>
					</CardHeader>
					<CardContent class="space-y-3">
						{#each featureCards as item}
							{@const FeatureIcon = item.icon}
							<div class="rounded-lg border p-3">
								<div class="flex items-start gap-3">
									<div class="rounded-md bg-primary/10 p-2 text-primary">
										<FeatureIcon class="size-4" />
									</div>
									<div>
										<p class="text-sm font-medium">{item.title}</p>
										<p class="mt-1 text-xs text-muted-foreground">{item.desc}</p>
									</div>
								</div>
							</div>
						{/each}
					</CardContent>
					<CardFooter class="text-xs text-muted-foreground">
						下一步：可继续实现撤销重做、光标同步和快照落盘策略展示。
					</CardFooter>
				</Card>
			</div>
		</section>
	</main>
</div>
