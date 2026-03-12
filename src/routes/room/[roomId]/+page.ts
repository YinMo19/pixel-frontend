import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, url }) => {
	return {
		roomId: params.roomId,
		initialNickname: url.searchParams.get('nickname')?.trim() ?? '',
		initialColor: url.searchParams.get('color')?.trim() ?? ''
	};
};
