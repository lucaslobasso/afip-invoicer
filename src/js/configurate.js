$(async function() {
    bindUploadSection();
    $("#submitConfig").on("click", submitConfiguration);
    $("#clearConfig").on("click", clearConfiguration);

    await loadConfiguration();
});

async function loadConfiguration() {
    let input = $("#cuit");

    try {
        let config = await api.getConfig();

        input.val(config.cuit);
        showFilesStatus(config.hasCert, config.hasKey);
    }
    catch (e) {
        errorMessage(e);
    }

    input.closest(".control").removeClass("is-loading");
}

function showFilesStatus(hasCert, hasKey) {
    setFileStatus($("#cert-status"), "Certificado", hasCert);
    setFileStatus($("#key-status"), "Clave", hasKey);
}

function setFileStatus(tag, name, loaded) {
    if (loaded === undefined) {
        return;
    }

    tag.text(`${name}: ${loaded ? "cargado" : "sin cargar"}`)
       .toggleClass("is-success", loaded)
       .toggleClass("is-light", !loaded);
}

async function submitConfiguration() {
    let btn    = $("#submitConfig"),
        fields = $("#configurate-fields");

    if (!setLoading(btn, fields)) {
        return;
    }

    try {
        let result = await api.saveConfig($("#cuit").val());

        if (result.ok) {
            goTo("generate_invoice.html");
            return;
        }
        if (result.errors.cuit) {
            invalidInput($("#cuit"));
        }
        if (result.errors.files) {
            errorMessage(result.errors.files);
        }
    }
    catch (e) {
        errorMessage(e);
    }

    setLoading(btn, fields, false);
}

async function clearConfiguration() {
    let btn = $("#clearConfig");

    if (!window.confirm("¿Borrar el CUIT/CUIL, el certificado y la clave cargados?") || !setLoading(btn)) {
        return;
    }

    try {
        await api.clearConfig();
        $("#cuit").val("");
        showFilesStatus(false, false);
        infoMessage("Configuración borrada.");
    }
    catch (e) {
        errorMessage(e);
    }

    setLoading(btn, null, false);
}

function bindUploadSection() {
    let uploadSection = document.getElementById("upload-section");

    uploadSection.addEventListener('click', () => {
        importFiles(() => api.pickFiles());
    });

    uploadSection.addEventListener('drop', (e) => {
        let files = Array.from(e.dataTransfer.files);

        e.preventDefault();
        e.stopPropagation();
        uploadSection.classList.add("is-light");

        importFiles(() => api.importFiles(files));
    });

    uploadSection.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    uploadSection.addEventListener('dragenter', () => {
        uploadSection.classList.remove("is-light");
    });

    uploadSection.addEventListener('dragleave', () => {
        uploadSection.classList.add("is-light");
    });
}

async function importFiles(doImport) {
    let submitBtn = $("#submitConfig");

    submitBtn.addClass("is-loading");

    try {
        let result = await doImport();

        // `null`: el usuario canceló el diálogo.
        if (result) {
            let config = await api.getConfig();

            showFilesStatus(config.hasCert, config.hasKey);

            if (result.rejected.length) {
                errorMessage(`No es un certificado ni una clave privada en formato PEM: ${result.rejected.join(", ")}`);
            }
        }
    }
    catch (e) {
        errorMessage("Se produjo un error al cargar el/los archivo/s.");
    }

    submitBtn.removeClass("is-loading");
}
