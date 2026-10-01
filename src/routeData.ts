import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

// Splash pages (the home page) have no sidebar, so Starlight renders no mobile hamburger there.
// Enable it so the menu is available on mobile and tablet; the sidebar is hidden on desktop in home.css.
export const onRequest = defineRouteMiddleware((context) => {
	const { starlightRoute } = context.locals;
	if (starlightRoute.entry.data.template === 'splash') {
		starlightRoute.hasSidebar = true;
	}
});
