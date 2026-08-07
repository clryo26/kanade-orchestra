const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
    return fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');
}

describe('image upload FormData migration', () => {
    test('save paths no longer use fileToDataUrl and use multipart FormData', () => {
        const membersApi = read('src/static/js/modules/members/api.js');
        const performances = read('src/static/js/modules/performances.js');
        const promotionsApi = read('src/static/js/modules/date_piece_promotion/api.js');
        const portalViews = read('src/static/js/modules/portal_views.js');
        const adminApi = read('src/static/js/modules/admin_system/api.js');
        const adminRender = read('src/static/js/modules/admin_system/render.js');
        const commonHelpers = read('src/static/js/modules/common_helpers/pure.js');

        for (const source of [membersApi, performances, promotionsApi, portalViews, adminApi, adminRender, commonHelpers]) {
            expect(source).not.toContain('fileToDataUrl');
        }

        expect(membersApi).toContain('new FormData()');
        expect(membersApi).toContain('photo_file');
        expect(performances).toContain('new FormData()');
        expect(performances).toContain('flyer_file');
        expect(promotionsApi).toContain('new FormData()');
        expect(promotionsApi).toContain('image_url_file');
        expect(portalViews).toContain('new FormData()');
        expect(portalViews).toContain('profilePhotoFile');
        expect(adminApi).toContain('new FormData()');
        expect(adminApi).toContain('icon_url_file');
        expect(adminRender).toContain('URL.createObjectURL');
    });
});
