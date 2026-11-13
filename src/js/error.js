// Muestra el detalle del error (si lo hay) que llega en la URL.
// Los botones de reintento navegan solos vía `data-view` (ver main.js).
$(function() {
    let detail = new URLSearchParams(window.location.search).get("detail");

    if (detail) {
        $("#error-detail").text(detail).removeClass("is-hidden");
    }
});
