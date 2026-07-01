// Practice/casting event bindings split from modules/practice_casting.js.
// Keep global names for compatibility with legacy non-module loading.

function bindCastingAdminEvents() {
    const addExtraBtn = $('castingAddExtraBtn');
    const saveBtn = $('castingSaveBtn');
    const deleteBtn = $('castingDeleteBtn');
    const clearBtn = $('castingClearBtn');

    if (addExtraBtn) {
        addExtraBtn.addEventListener('click', () => {
            appState.castingEditingExtras.push({ name: '', furigana: '', part: '' });
            renderCastingExtrasList();
        });
    }
    if (saveBtn) saveBtn.addEventListener('click', () => saveCasting());
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteCasting());
    if (clearBtn) clearBtn.addEventListener('click', () => clearCastingForm());
}