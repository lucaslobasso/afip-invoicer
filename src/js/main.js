// Código común a todas las vistas. Las vistas no tienen acceso a Node:
// todo lo que toca el disco o ARCA pasa por `window.croessant` (ver src/main/preload.js).
const api = window.croessant;

const CONCEPTS = { 1: 'Productos', 2: 'Servicios', 3: 'Productos y Servicios' };

bulmaToast.setDefaults({
    type: 'is-danger',
    duration: 3000,
    pauseOnHover: true,
    dismissible: true,
    closeOnClick: false,
    animate: { in: 'fadeIn', out: 'fadeOut' }
});

$(function() {
    // Navegación entre vistas y reconexión, sin handlers inline (los bloquea la CSP).
    $(document).on("click", "[data-view]", function() {
        if (setLoading($(this))) {
            goTo($(this).data("view"));
        }
    });
    $(document).on("click", "[data-action='reconnect']", function() {
        window.location.reload();
    });
});

function goTo(view) {
    window.location.href = view;
}

function escapeHtml(text) {
    return $("<div />").text(text).html();
}

function successMessage(msg) {
    bulmaToast.toast({ message: escapeHtml(msg), type: 'is-success', duration: 5000 });
}

function errorMessage(error) {
    let msg = error && error.message ? error.message : String(error);

    // Los errores de ARCA suelen ser largos: se muestran más tiempo.
    bulmaToast.toast({ message: escapeHtml(msg), duration: 8000 });
    console.error(error);
}

function infoMessage(msg) {
    bulmaToast.toast({ message: escapeHtml(msg), type: 'is-info' });
}

/**
 * Marca un botón (y opcionalmente un fieldset) como "trabajando".
 * Al activar devuelve `false` si ya estaba trabajando, para evitar envíos dobles.
 */
function setLoading(btn, fields, loading = true) {
    if (loading && btn.hasClass("is-loading")) {
        return false;
    }

    btn.toggleClass("is-loading", loading);

    if (fields) {
        fields.prop("disabled", loading);
    }

    return true;
}

function invalidInput(input, invalid = true) {
    let validation = input.closest(".field").find("p.help");

    input.toggleClass("is-danger", invalid);
    validation.toggleClass("is-hidden", !invalid);

    input.off(".validation").one("change.validation input.validation changeDate.validation", function() {
        invalidInput(input, false);
    });
}

/**
 * Conecta con ARCA y carga los puntos de venta en `#pointOfSale`.
 * Si algo falla navega a la pantalla de error correspondiente y devuelve `false`.
 */
async function connectToArca() {
    let spinner = $("#page-loader"),
        input   = $("#pointOfSale"),
        result;

    spinner.addClass("is-active");

    try {
        result = await api.connect();
    }
    catch (e) {
        result = { status: "offline", message: e.message };
    }

    if (result.status !== "ok") {
        let pages = {
                "not-configured"    : "configurate.html",
                "auth"              : "error/configuration.html",
                "no-points-of-sale" : "error/point_of_sale.html",
                "offline"           : "error/connection.html"
            },
            detail = result.message ? `?detail=${encodeURIComponent(result.message)}` : "";

        goTo(pages[result.status] + detail);
        return false;
    }

    input.empty();
    result.pointsOfSale.forEach(point => {
        input.append($("<option />", { text: `${point.number}: ${point.type}`, value: point.number }));
    });
    input.prop("disabled", result.pointsOfSale.length == 1);

    spinner.removeClass("is-active");
    return true;
}

// Fechas: ARCA usa yyyymmdd; siempre se convierten en hora local.
function toArcaDate(date) {
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function fromArcaDate(value) {
    let text = String(value);

    return new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
}

function addDate(date, days = 0, months = 0) {
    return new Date(date.getFullYear(), date.getMonth() + months, date.getDate() + days);
}

function formatDate(arcaDate) {
    return fromArcaDate(arcaDate).toLocaleDateString("es-AR");
}

function formatAmount(amount) {
    return Number(amount).toLocaleString("es-AR", { style: "currency", currency: "ARS" });
}
