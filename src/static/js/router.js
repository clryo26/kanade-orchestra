export function createRouter(store) {
    return {
        currentRoute() {
            return window.location.hash || '#/';
        },
        navigate(route) {
            window.location.hash = route;
            store.setState({ route });
        },
    };
}
