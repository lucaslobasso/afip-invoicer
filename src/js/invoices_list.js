let rangePicker;

$(async function() {
    let btn    = $("#searchInvoices"),
        fields = $("#filter-fields");

    fields.prop("disabled", true);

    try {
        if (!await connectToArca()) {
            return;
        }

        rangePicker = new DateRangePicker($("#range")[0], {
            autohide        : true,
            todayHighlight  : true,
            orientation     : "bottom",
            maxDate         : addDate(new Date(), 10),
            language        : "es"
        });
        rangePicker.setDates(addDate(new Date(), -1), new Date());

        btn.on("click", searchInvoices);
        $("#pointOfSale").on("change", searchInvoices);
    }
    catch (e) {
        errorMessage(e);
    }

    $("#page-loader").removeClass("is-active");
    fields.prop("disabled", false);

    await searchInvoices();
});

async function searchInvoices() {
    let btn     = $("#searchInvoices"),
        fields  = $("#filter-fields"),
        spinner = $("#invoices-loader"),
        noData  = $("#invoice-list-no-items"),
        total   = $("#invoices-total"),
        [from, to] = rangePicker ? rangePicker.getDates() : [];

    if (!from || !to) {
        errorMessage("Elegí un rango de fechas.");
        return;
    }
    if (!setLoading(btn, fields)) {
        return;
    }

    spinner.addClass("is-active");
    noData.addClass("is-hidden");
    total.addClass("is-hidden");
    $(".invoice-list-item:not([id])").remove();

    try {
        let invoices = await api.listInvoices({
            pointOfSale : $("#pointOfSale").val(),
            from        : String(toArcaDate(from)),
            to          : String(toArcaDate(to))
        });

        showInvoices(invoices);
    }
    catch (e) {
        errorMessage(e);
    }

    spinner.removeClass("is-active");
    setLoading(btn, fields, false);
}

function showInvoices(invoices) {
    let list     = $("#invoices-list"),
        template = $("#invoice-list-item-template"),
        total    = $("#invoices-total");

    if (!invoices.length) {
        $("#invoice-list-no-items").removeClass("is-hidden");
        return;
    }

    invoices.forEach(invoice => {
        let item = template.clone();

        item.removeAttr("id");
        item.removeClass("is-hidden");
        item.find(".invoice-number").text(invoice.number);
        item.find(".invoice-date").text(formatDate(invoice.date));
        item.find(".invoice-concept").text(CONCEPTS[invoice.concept] || "");
        item.find(".invoice-amount").text(formatAmount(invoice.total));
        item.appendTo(list);
    });

    // Se suma en centavos para no arrastrar errores de punto flotante.
    let cents = invoices.reduce((sum, invoice) => sum + Math.round(invoice.total * 100), 0);

    total.find(".total-amount").text(formatAmount(cents / 100));
    total.removeClass("is-hidden");
}
