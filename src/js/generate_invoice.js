let datePicker, appInfo,
    lastInvoice = { number: 0, date: null },
    dateRange   = null;

$(async function() {
    let btn    = $("#generateInvoice"),
        fields = $("#invoice-fields");

    fields.prop("disabled", true);

    try {
        appInfo = await api.info();
        $("#amount-help").text(`Debe ser mayor a 0 y menor a ${formatAmount(appInfo.maxAmount)}.`);

        if (!await connectToArca()) {
            return;
        }

        datePicker = new Datepicker($("#date")[0], {
            autohide        : true,
            todayHighlight  : true,
            orientation     : "bottom",
            language        : "es"
        });

        await updateLastInvoice();

        $("#concept").on("change", refresh(updateDateRange));
        $("#pointOfSale").on("change", refresh(updateLastInvoice));
        btn.on("click", generateInvoice);
    }
    catch (e) {
        errorMessage(e);
    }

    $("#page-loader").removeClass("is-active");
    setLoading(btn, fields, false);
});

/** Envuelve una actualización bloqueando el formulario mientras corre. */
function refresh(update) {
    return async function() {
        let btn    = $("#generateInvoice"),
            fields = $("#invoice-fields");

        if (!setLoading(btn, fields)) {
            return;
        }

        try {
            await update();
        }
        catch (e) {
            errorMessage(e);
        }

        setLoading(btn, fields, false);
    };
}

async function updateLastInvoice() {
    lastInvoice = await api.lastInvoice($("#pointOfSale").val());
    await updateDateRange();
}

/** Limita el selector al rango de fechas que ARCA acepta hoy para el concepto elegido. */
async function updateDateRange() {
    dateRange = await api.invoiceDateRange($("#concept").val(), lastInvoice.date);

    let min      = fromArcaDate(dateRange.min),
        max      = fromArcaDate(dateRange.max),
        current  = datePicker.getDate(),
        today    = toArcaDate(new Date()),
        fallback = fromArcaDate(Math.min(Math.max(today, dateRange.min), dateRange.max));

    datePicker.setOptions({ minDate: min, maxDate: max });

    if (!current || current < min || current > max) {
        datePicker.setDate(fallback);
    }
}

async function generateInvoice() {
    let btn    = $("#generateInvoice"),
        fields = $("#invoice-fields");

    if (!validateForm() || !setLoading(btn, fields)) {
        return;
    }

    try {
        let invoice = await api.createInvoice({
            pointOfSale : $("#pointOfSale").val(),
            concept     : $("#concept").val(),
            date        : String(toArcaDate(datePicker.getDate())),
            amount      : $("#amount").val()
        });

        $("#amount").val("");
        lastInvoice = { number: invoice.number, date: invoice.date };
        successMessage(`Comprobante nº ${invoice.number} generado correctamente. CAE: ${invoice.cae}`);
        await updateDateRange();
    }
    catch (e) {
        errorMessage(e);
    }

    setLoading(btn, fields, false);
}

function validateForm() {
    // Se evalúan los dos para marcar todos los campos inválidos a la vez.
    let validDate   = validateDate(),
        validAmount = validateAmount();

    return validDate && validAmount;
}

function validateDate() {
    let date  = datePicker.getDate(),
        value = date ? toArcaDate(date) : 0;

    if (dateRange && value >= dateRange.min && value <= dateRange.max) {
        return true;
    }

    invalidInput($("#date"));
    return false;
}

function validateAmount() {
    let input  = $("#amount"),
        amount = parseFloat(input.val());

    if (amount > 0 && amount < appInfo.maxAmount) {
        return true;
    }

    invalidInput(input);
    return false;
}
