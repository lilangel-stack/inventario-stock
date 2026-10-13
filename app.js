const DB_NAME = "mi-negocio-db";
const DB_VERSION = 1;
const CURRENCY = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
const DATE_FORMAT = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const VIEW_TITLES = {
  inicio: "Resumen del negocio",
  compras: "Compras a proveedores",
  ventas: "Registrar una venta",
  inventario: "Inventario",
  gastos: "Gastos y pagos",
  facturas: "Facturas de venta",
};

let database;
let activeUser = null;
let products = [];
let purchases = [];
let sales = [];
let expenses = [];
let noticeTimer;
let authMode = "login";
const THEME_STORAGE_KEY = "mi-negocio-theme";
const LEGACY_MIGRATION_STORAGE_KEY = "mi-negocio-legacy-migrated-v1";

const byId = (id) => document.getElementById(id);
const money = (amount) => CURRENCY.format(Number(amount) || 0);
const today = () => {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};
const formatDate = (date) =>
  date ? DATE_FORMAT.format(new Date(`${date}T12:00:00`)) : "—";
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
const rowOrEmpty = (row, message, colspan) =>
  row || `<tr class="empty-row"><td colspan="${colspan}">${message}</td></tr>`;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("products")) {
        db.createObjectStore("products", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("purchases")) {
        db.createObjectStore("purchases", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("sales")) {
        db.createObjectStore("sales", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("expenses")) {
        db.createObjectStore("expenses", { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error("No se pudo abrir la base de datos."));
    request.onblocked = () => reject(new Error("Cierra otras pestañas de esta app e inténtalo de nuevo."));
  });
}

function getAll(storeName, source) {
  return new Promise((resolve, reject) => {
    const request = source.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudieron leer los datos."));
  });
}

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error("No se pudo conectar con el servidor. Inicia la aplicación con npm start y abre la dirección que indica la terminal.");
  }

  const apiPath = path.startsWith("/api/");
  const unsupportedApiMessage = "El servidor abierto no admite el registro ni el inicio de sesión. Inicia la app con npm start y abre la dirección que muestra la terminal; no abras index.html directamente ni uses Live Server.";
  const contentType = response.headers.get("content-type") || "";
  let result;
  if (apiPath && !contentType.toLowerCase().includes("application/json")) {
    if (response.status === 405) {
      throw new Error(unsupportedApiMessage);
    }
    throw new Error("El servidor abierto no tiene activa la API de la tienda. Inicia la app con npm start y abre la dirección que muestra la terminal.");
  }
  try {
    result = await response.json();
  } catch {
    throw new Error("El servidor respondió con datos inválidos. Inicia de nuevo la app con npm start y abre la dirección que muestra la terminal.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("El servidor respondió con datos inválidos. Inicia de nuevo la app con npm start y abre la dirección que muestra la terminal.");
  }
  if (!response.ok) {
    const message = response.status === 405 && apiPath
      ? unsupportedApiMessage
      : result.error || (
        response.status === 404 && apiPath
          ? "Este servidor no tiene activa la API. Detén el servidor anterior y vuelve a iniciar la app con npm start."
          : `La solicitud falló (${response.status}).`
      );
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function readCloudData() {
  const { data } = await apiRequest("/api/data");
  return data;
}

async function migrateLegacyData(cloudData) {
  let migrationComplete;
  try {
    migrationComplete = localStorage.getItem(LEGACY_MIGRATION_STORAGE_KEY) === "true";
  } catch (error) {
    showNotice(`No se pudo comprobar si hay datos antiguos en este dispositivo: ${error.message}`, true);
    return cloudData;
  }
  if (migrationComplete) return cloudData;

  try {
    const legacyDatabase = await openDatabase();
    let legacyData;
    try {
      legacyData = Object.fromEntries(await Promise.all(
        ["products", "purchases", "sales", "expenses"].map(async (store) => [
          store,
          await getAll(store, legacyDatabase),
        ]),
      ));
    } finally {
      legacyDatabase.close();
    }
    const cloudHasRecords = Object.values(cloudData).some((records) => records.length > 0);
    const legacyHasRecords = Object.values(legacyData).some((records) => records.length > 0);

    if (!cloudHasRecords && legacyHasRecords) {
      await apiRequest("/api/data", {
        method: "PUT",
        body: JSON.stringify({ data: legacyData }),
      });
      try {
        localStorage.setItem(LEGACY_MIGRATION_STORAGE_KEY, "true");
      } catch (error) {
        showNotice(`Tus datos se sincronizaron, pero no se pudo guardar la marca de migración local: ${error.message}`, true);
      }
      showNotice("Tus datos guardados anteriormente en este dispositivo ya están en tu tienda.");
      return legacyData;
    }
  } catch (error) {
    showNotice(`No se pudieron migrar los datos anteriores de este dispositivo: ${error.message}`, true);
    return cloudData;
  }

  try {
    localStorage.setItem(LEGACY_MIGRATION_STORAGE_KEY, "true");
  } catch (error) {
    showNotice(`No se pudo guardar la marca de migración local: ${error.message}`, true);
  }
  return cloudData;
}

async function saveRecords(records) {
  const data = Object.fromEntries(
    [...new Set(records.map(({ store }) => store))].map((store) => [
      store,
      records.filter((record) => record.store === store).map(({ value }) => value),
    ]),
  );
  await apiRequest("/api/data", {
    method: "PUT",
    body: JSON.stringify({ data }),
  });
}

function showNotice(message, isError = false) {
  const notice = byId("notice");
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 5000);
}

function setDefaultDates() {
  document.querySelectorAll('input[type="date"]').forEach((input) => {
    input.value = today();
  });
  byId("today-chip").textContent = DATE_FORMAT.format(new Date());
}

function setAccountBranding(user) {
  const firstName = user.firstName?.trim() || "bienvenido";
  const storeName = user.storeName?.trim() || "Mi negocio";
  byId("today-label").textContent = `¡Te damos la bienvenida, ${firstName}!`;
  byId("account-store-name").textContent = storeName;
  byId("store-initial").textContent = storeName.slice(0, 1).toLocaleUpperCase("es");
  byId("account-owner").textContent = firstName;
}

function setView(view) {
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${view}`);
  });
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  byId("page-title").textContent = VIEW_TITLES[view] || VIEW_TITLES.inicio;
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  const label = isDark ? "Modo claro" : "Modo oscuro";
  const toggle = byId("theme-toggle");
  toggle.setAttribute("aria-label", `Cambiar a ${label.toLocaleLowerCase("es")}`);
  toggle.title = `Cambiar a ${label.toLocaleLowerCase("es")}`;
  byId("theme-label").textContent = label;
  byId("theme-icon").textContent = isDark ? "☀" : "☾";
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#11141c" : "#f5f6f8";
}

function bindThemeToggle() {
  let savedTheme = "light";
  try {
    savedTheme = localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch (error) {
    console.warn("No se pudo leer la preferencia de tema guardada.", error);
  }
  applyTheme(savedTheme);

  byId("theme-toggle").addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch (error) {
      showNotice(`El tema cambió, pero no se pudo guardar la preferencia: ${error.message}`, true);
    }
  });
}

function bindNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelectorAll("[data-go]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.go));
  });
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = authMode === "register";
  byId("auth-title").textContent = registering ? "Crea tu tienda" : "Accede a tu tienda";
  byId("auth-description").textContent = registering
    ? "Ingresa tus datos y crea una clave privada para esta tienda independiente."
    : "Escribe la clave especial de la tienda a la que quieres acceder.";
  byId("auth-submit").textContent = registering ? "Crear tienda y clave" : "Entrar a mi tienda";
  byId("auth-switch-copy").firstChild.textContent = registering
    ? "¿Ya tienes una tienda? "
    : "¿Quieres crear otra tienda? ";
  byId("auth-switch").textContent = registering ? "Iniciar sesión" : "Crear otra tienda";
  byId("auth-switch-copy").hidden = false;
  byId("auth-password").minLength = registering ? 12 : 8;
  byId("auth-password").placeholder = registering
    ? "Crea una clave segura de 12 caracteres o más"
    : "Clave privada de acceso a la tienda";
  byId("auth-privacy").textContent = registering
    ? "Cada tienda tiene sus propios datos y clave. Guarda la clave privada: no se puede recuperar."
    : "Cada clave abre una tienda independiente. Comparte la clave solo con personas autorizadas.";
  byId("auth-password").autocomplete = registering ? "new-password" : "current-password";
  byId("confirm-password-field").hidden = !registering;
  byId("auth-confirm-password").required = registering;
  byId("register-fields").hidden = !registering;
  for (const id of ["auth-first-name", "auth-last-name", "auth-store-name"]) {
    byId(id).required = registering;
  }
  for (const id of ["auth-password", "auth-confirm-password"]) {
    byId(id).type = "password";
    const toggle = document.querySelector(`[data-password-target="${id}"]`);
    toggle.textContent = "Mostrar";
    toggle.setAttribute("aria-pressed", "false");
    toggle.setAttribute(
      "aria-label",
      id === "auth-password"
        ? "Mostrar clave especial"
        : "Mostrar confirmación de clave especial",
    );
  }
  byId("auth-error").hidden = true;
}

function showAuthentication(message = "") {
  activeUser = null;
  products = [];
  purchases = [];
  sales = [];
  expenses = [];
  byId("app-shell").hidden = true;
  byId("auth-screen").hidden = false;
  setAuthMode("login");
  if (message) {
    byId("auth-error").textContent = message;
    byId("auth-error").hidden = false;
  }
  byId("auth-password").focus();
}

async function enterApplication(user) {
  activeUser = user;
  setAccountBranding(user);
  byId("auth-screen").hidden = true;
  byId("app-shell").hidden = false;
  try {
    const cloudData = await readCloudData();
    const data = await migrateLegacyData(cloudData);
    [products, purchases, sales, expenses] = [
      data.products,
      data.purchases,
      data.sales,
      data.expenses,
    ];
    renderAll();
    const requestedView = location.hash.slice(1);
    setView(VIEW_TITLES[requestedView] ? requestedView : "inicio");
  } catch (error) {
    if (error.status === 401) {
      showAuthentication("Tu sesión venció. Inicia sesión de nuevo para continuar.");
      return;
    }
    showNotice(`No se pudieron cargar los datos de tu tienda: ${error.message}`, true);
  }
}

async function handleAuthentication(event) {
  event.preventDefault();
  const errorMessage = byId("auth-error");
  const submit = byId("auth-submit");
  const password = byId("auth-password").value;
  const profile = authMode === "register"
    ? {
        firstName: byId("auth-first-name").value,
        lastName: byId("auth-last-name").value,
        storeName: byId("auth-store-name").value,
      }
    : {};
  if (authMode === "register" && password !== byId("auth-confirm-password").value) {
    errorMessage.textContent = "Las claves no coinciden.";
    errorMessage.hidden = false;
    return;
  }

  submit.disabled = true;
  errorMessage.hidden = true;
  submit.textContent = authMode === "register" ? "Creando tienda…" : "Abriendo tienda…";
  try {
    const endpoint = authMode === "register" ? "/api/register" : "/api/login";
    const { user } = await apiRequest(endpoint, {
      method: "POST",
      body: JSON.stringify({ password, ...profile }),
    });
    await enterApplication(user);
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = authMode === "register" ? "Crear tienda y clave" : "Entrar a mi tienda";
  }
}

async function handleLogout() {
  try {
    await apiRequest("/api/logout", { method: "POST" });
    showAuthentication();
  } catch (error) {
    showNotice(`No se pudo cerrar la sesión con el servidor: ${error.message}`, true);
  }
}

function bindAuthentication() {
  byId("auth-form").addEventListener("submit", handleAuthentication);
  byId("auth-switch").addEventListener("click", () => {
    setAuthMode(authMode === "register" ? "login" : "register");
  });
  byId("logout-button").addEventListener("click", handleLogout);
  byId("auth-form").addEventListener("input", () => {
    byId("auth-error").hidden = true;
  });
  document.querySelectorAll("[data-password-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = byId(button.dataset.passwordTarget);
      const isVisible = input.type === "password";
      input.type = isVisible ? "text" : "password";
      button.textContent = isVisible ? "Ocultar" : "Mostrar";
      button.setAttribute("aria-pressed", String(isVisible));
      button.setAttribute(
        "aria-label",
        `${isVisible ? "Ocultar" : "Mostrar"} ${input.id === "auth-password" ? "clave especial" : "confirmación de clave especial"}`,
      );
      input.focus();
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && activeUser) {
      refreshData().catch((error) => showNotice(`No se pudieron sincronizar tus datos: ${error.message}`, true));
    }
  });
  window.setInterval(() => {
    if (activeUser && document.visibilityState === "visible") {
      refreshData().catch((error) => showNotice(`No se pudieron sincronizar tus datos: ${error.message}`, true));
    }
  }, 30000);
}

async function refreshData() {
  const data = await readCloudData();
  [products, purchases, sales, expenses] = [
    data.products,
    data.purchases,
    data.sales,
    data.expenses,
  ];
  renderAll();
}

function renderAll() {
  renderDashboard();
  renderInventory();
  renderExpenses();
  renderInvoices();
  populateProductOptions();
  updateSaleCalculation();
  updatePurchaseTotal();
}

function renderDashboard() {
  const revenue = sales.reduce((sum, sale) => sum + sale.total, 0);
  const investment = purchases.reduce((sum, purchase) => sum + purchase.total, 0);
  const soldCost = sales.reduce((sum, sale) => sum + sale.cost, 0);
  const saleCosts = sales.reduce((sum, sale) => sum + sale.commission + sale.delivery, 0);
  const otherExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const profit = revenue - soldCost - saleCosts - otherExpenses;
  const inventoryValue = products.reduce((sum, product) => sum + product.stock * product.unitCost, 0);
  const stockCount = products.reduce((sum, product) => sum + product.stock, 0);
  const receivable = sales.reduce((sum, sale) => sum + sale.balance, 0);

  byId("metric-sales").textContent = money(revenue);
  byId("metric-sales-count").textContent = `${sales.length} ${sales.length === 1 ? "venta" : "ventas"}`;
  byId("metric-investment").textContent = money(investment);
  byId("metric-profit").textContent = money(profit);
  byId("metric-inventory").textContent = money(inventoryValue);
  byId("metric-stock-count").textContent = `${stockCount} ${stockCount === 1 ? "unidad" : "unidades"} en stock`;
  byId("metric-expenses").textContent = money(saleCosts + otherExpenses);
  byId("metric-receivable").textContent = money(receivable);

  const soldByProduct = new Map();
  for (const sale of sales) {
    soldByProduct.set(sale.productName, (soldByProduct.get(sale.productName) || 0) + sale.quantity);
  }
  const rankedProducts = [...soldByProduct.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"));
  const topProduct = rankedProducts[0];
  byId("top-product").textContent = topProduct ? topProduct[0] : "Aún no hay ventas";
  byId("top-product-quantity").textContent = topProduct ? `${topProduct[1]} uds.` : "—";
  renderDashboardCharts(revenue, saleCosts + otherExpenses, rankedProducts);

  const lowStock = products.filter((product) => product.stock <= 3);
  byId("low-stock-count").textContent = lowStock.length
    ? `${lowStock.length} ${lowStock.length === 1 ? "producto" : "productos"} con 3 unidades o menos`
    : "Sin alertas";

  const activity = [
    ...sales.map((sale) => ({
      type: "Venta",
      detail: `${sale.productName} · ${sale.quantity} uds.`,
      date: sale.date,
      total: sale.total,
      className: "",
    })),
    ...purchases.map((purchase) => ({
      type: "Compra",
      detail: `${purchase.productName} · ${purchase.quantity} uds.`,
      date: purchase.date,
      total: purchase.total,
      className: "purchase",
    })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  byId("recent-activity").innerHTML = rowOrEmpty(
    activity.map((item) => `<tr><td><span class="type-pill ${item.className}">${item.type}</span></td><td>${escapeHtml(item.detail)}</td><td>${formatDate(item.date)}</td><td class="align-right">${money(item.total)}</td></tr>`).join(""),
    "Registra tu primera compra o venta para ver actividad.",
    4,
  );
}

function renderDashboardCharts(revenue, totalExpenses, rankedProducts) {
  const difference = revenue - totalExpenses;
  const maxAmount = Math.max(revenue, totalExpenses, Math.abs(difference), 1);
  const financialRows = [
    { label: "Ventas", amount: revenue, className: "sales" },
    { label: "Gastos", amount: totalExpenses, className: "expenses" },
    { label: "Diferencia", amount: difference, className: difference < 0 ? "negative" : "difference" },
  ];
  byId("financial-chart").innerHTML = financialRows.map(({ label, amount, className }) => {
    const width = Math.min(100, Math.abs(amount) / maxAmount * 100);
    const sign = amount < 0 ? "−" : "";
    return `<div class="chart-row"><div class="chart-row-label"><span>${label}</span><strong>${sign}${money(Math.abs(amount))}</strong></div><div class="chart-bar-track"><span class="chart-bar ${className}" style="width:${width}%"></span></div></div>`;
  }).join("");

  const topProducts = rankedProducts.slice(0, 5);
  if (topProducts.length === 0) {
    byId("top-products-chart").innerHTML = '<p class="chart-empty">Registra ventas para ver los productos más vendidos.</p>';
    return;
  }
  const maxQuantity = topProducts[0][1];
  byId("top-products-chart").innerHTML = topProducts.map(([name, quantity], index) => {
    const width = quantity / maxQuantity * 100;
    return `<div class="chart-row product-chart-row"><div class="chart-row-label"><span class="chart-product-name"><b>${index + 1}</b>${escapeHtml(name)}</span><strong>${quantity} ${quantity === 1 ? "ud." : "uds."}</strong></div><div class="chart-bar-track"><span class="chart-bar product product-${index + 1}" style="width:${width}%"></span></div></div>`;
  }).join("");
}

function renderInventory() {
  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name, "es"));
  byId("inventory-table").innerHTML = rowOrEmpty(
    sorted.map((product) => `<tr><td><strong>${escapeHtml(product.name)}</strong></td><td>${escapeHtml(product.supplier || "—")}</td><td class="align-right">${money(product.unitCost)}</td><td class="align-right">${product.stock}${product.stock <= 3 ? ' <span class="type-pill purchase">Stock bajo</span>' : ""}</td><td class="align-right">${money(product.stock * product.unitCost)}</td></tr>`).join(""),
    "Todavía no hay productos. Registra una compra para iniciar tu inventario.",
    5,
  );
}

function renderExpenses() {
  const rows = [
    ...expenses.map((expense) => ({
      category: expense.category,
      description: expense.description,
      date: expense.date,
      amount: expense.amount,
    })),
    ...sales.filter((sale) => sale.commission > 0).map((sale) => ({
      category: "Comisión",
      description: `${sale.seller || "Vendedor"} · Factura ${sale.invoiceNumber}`,
      date: sale.date,
      amount: sale.commission,
    })),
    ...sales.filter((sale) => sale.delivery > 0).map((sale) => ({
      category: "Reparto",
      description: `Factura ${sale.invoiceNumber}`,
      date: sale.date,
      amount: sale.delivery,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  byId("expenses-table").innerHTML = rowOrEmpty(
    rows.map((expense) => `<tr><td>${escapeHtml(expense.category)}</td><td>${escapeHtml(expense.description)}</td><td>${formatDate(expense.date)}</td><td class="align-right">${money(expense.amount)}</td></tr>`).join(""),
    "Aún no has registrado gastos ni pagos.",
    4,
  );
}

function renderInvoices() {
  const sorted = [...sales].sort((a, b) => b.date.localeCompare(a.date));
  byId("invoices-table").innerHTML = rowOrEmpty(
    sorted.map((sale) => `<tr><td><strong>${escapeHtml(sale.invoiceNumber)}</strong></td><td>${escapeHtml(sale.customer || "Cliente")}${sale.seller ? ` · ${escapeHtml(sale.seller)}` : ""}</td><td>${formatDate(sale.date)}</td><td class="align-right">${money(sale.total)}</td><td class="align-right"><button class="invoice-button" data-view-invoice="${escapeHtml(sale.id)}">Ver factura</button></td></tr>`).join(""),
    "Las facturas aparecerán aquí cuando registres una venta.",
    5,
  );
  byId("invoices-table").querySelectorAll("[data-view-invoice]").forEach((button) => {
    button.addEventListener("click", () => {
      const sale = sales.find((item) => item.id === button.dataset.viewInvoice);
      if (sale) showInvoice(sale);
    });
  });
}

function populateProductOptions() {
  const select = byId("sale-product");
  const selectedId = select.value;
  select.innerHTML = `<option value="">Selecciona un producto</option>${[...products]
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
    .map((product) => `<option value="${escapeHtml(product.id)}" ${product.stock < 1 ? "disabled" : ""}>${escapeHtml(product.name)} · ${product.stock} uds. · ${money(product.unitCost)}</option>`)
    .join("")}`;
  if (products.some((product) => product.id === selectedId)) select.value = selectedId;
}

function readSaleCalculation() {
  const form = byId("sale-form");
  const product = products.find((item) => item.id === form.elements.productId.value);
  const quantity = Math.max(0, Number(form.elements.quantity.value) || 0);
  const margin = Math.max(0, Number(form.elements.margin.value) || 0);
  const installmentCount = Math.max(1, Number(form.elements.installments.value) || 1);
  const cost = product ? product.unitCost * quantity : 0;
  const total = Math.round(cost * (1 + margin / 100) * 100) / 100;
  const downPayment = Math.round(total * 0.2 * 100) / 100;
  const balance = Math.round((total - downPayment) * 100) / 100;
  return { product, quantity, margin, installmentCount, cost, total, downPayment, balance };
}

function updateSaleCalculation() {
  const calculation = readSaleCalculation();
  byId("sale-cost").textContent = money(calculation.cost);
  byId("sale-total").textContent = money(calculation.total);
  byId("sale-down-payment").textContent = money(calculation.downPayment);
  byId("sale-installment").textContent = money(calculation.balance / calculation.installmentCount);
  byId("sale-installment-count").textContent = `${calculation.installmentCount} ${calculation.installmentCount === 1 ? "cuota" : "cuotas"}`;
  byId("sale-stock-hint").textContent = calculation.product
    ? `${calculation.product.stock} unidades disponibles${calculation.quantity > calculation.product.stock ? " · Cantidad superior al stock disponible" : ""}. La cuota inicial es el 20% del precio de venta.`
    : "Selecciona un producto para consultar el stock.";
}

function updatePurchaseTotal() {
  const form = byId("purchase-form");
  const total = (Number(form.elements.quantity.value) || 0) * (Number(form.elements.unitCost.value) || 0);
  byId("purchase-total").textContent = money(total);
}

function makeId() {
  return crypto.randomUUID();
}

async function handlePurchase(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const name = String(data.get("product")).trim();
  const supplier = String(data.get("supplier")).trim();
  const quantity = Number(data.get("quantity"));
  const unitCost = Number(data.get("unitCost"));
  const date = String(data.get("date"));
  if (!name || !Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(unitCost) || unitCost <= 0) {
    showNotice("Verifica el producto, la cantidad y el costo de la compra.", true);
    return;
  }

  const existing = products.find((product) => product.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es"));
  const oldQuantity = existing?.stock || 0;
  const newQuantity = oldQuantity + quantity;
  const averageCost = ((oldQuantity * (existing?.unitCost || 0)) + (quantity * unitCost)) / newQuantity;
  const product = {
    id: existing?.id || makeId(),
    name,
    supplier: supplier || existing?.supplier || "",
    stock: newQuantity,
    unitCost: Math.round(averageCost * 100) / 100,
  };
  const purchase = {
    id: makeId(),
    productId: product.id,
    productName: name,
    supplier,
    quantity,
    unitCost,
    total: Math.round(quantity * unitCost * 100) / 100,
    date,
  };
  try {
    await saveRecords([
      { store: "products", value: product },
      { store: "purchases", value: purchase },
    ]);
    form.reset();
    form.elements.date.value = today();
    updatePurchaseTotal();
    await refreshData();
    showNotice(`Compra guardada. Se agregaron ${quantity} unidades de ${name} al inventario.`);
  } catch (error) {
    showNotice(`No se pudo guardar la compra: ${error.message}`, true);
  }
}

async function handleSale(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const calculation = readSaleCalculation();
  if (!calculation.product || calculation.quantity < 1 || !Number.isInteger(calculation.quantity)) {
    showNotice("Selecciona un producto e ingresa una cantidad entera válida.", true);
    return;
  }
  if (calculation.quantity > calculation.product.stock) {
    showNotice(`Stock insuficiente. Solo hay ${calculation.product.stock} unidades disponibles.`, true);
    return;
  }
  const commission = Number(form.elements.commission.value) || 0;
  const delivery = Number(form.elements.delivery.value) || 0;
  if (commission < 0 || delivery < 0) {
    showNotice("La comisión y el pago al repartidor no pueden ser negativos.", true);
    return;
  }
  const invoiceNumber = `FAC-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const sale = {
    id: makeId(),
    invoiceNumber,
    productId: calculation.product.id,
    productName: calculation.product.name,
    quantity: calculation.quantity,
    unitCost: calculation.product.unitCost,
    cost: Math.round(calculation.cost * 100) / 100,
    margin: calculation.margin,
    total: calculation.total,
    downPayment: calculation.downPayment,
    balance: calculation.balance,
    installmentCount: calculation.installmentCount,
    installmentAmount: Math.round((calculation.balance / calculation.installmentCount) * 100) / 100,
    seller: String(form.elements.seller.value).trim(),
    commission: Math.round(commission * 100) / 100,
    delivery: Math.round(delivery * 100) / 100,
    customer: String(form.elements.customer.value).trim(),
    date: today(),
  };
  const updatedProduct = {
    ...calculation.product,
    stock: calculation.product.stock - calculation.quantity,
  };
  try {
    await saveRecords([
      { store: "products", value: updatedProduct },
      { store: "sales", value: sale },
    ]);
    form.reset();
    form.elements.quantity.value = "1";
    form.elements.margin.value = "30";
    form.elements.commission.value = "0";
    form.elements.delivery.value = "0";
    form.elements.installments.value = "4";
    await refreshData();
    setView("facturas");
    showNotice(`Venta guardada. Se generó la factura ${invoiceNumber}; puedes consultarla e imprimirla aquí.`);
  } catch (error) {
    showNotice(`No se pudo guardar la venta: ${error.message}`, true);
  }
}

async function handleExpense(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const amount = Number(data.get("amount"));
  if (!Number.isFinite(amount) || amount <= 0) {
    showNotice("Ingresa un valor mayor que cero para el gasto.", true);
    return;
  }
  const expense = {
    id: makeId(),
    category: String(data.get("category")),
    description: String(data.get("description")).trim(),
    amount: Math.round(amount * 100) / 100,
    date: String(data.get("date")),
  };
  try {
    await saveRecords([{ store: "expenses", value: expense }]);
    form.reset();
    form.elements.date.value = today();
    await refreshData();
    showNotice("El gasto o pago quedó guardado correctamente.");
  } catch (error) {
    showNotice(`No se pudo guardar el gasto: ${error.message}`, true);
  }
}

function invoiceMarkup(sale) {
  const storeName = activeUser?.storeName || "Mi negocio";
  return `<article class="invoice-paper"><header class="invoice-paper-header"><div><h1>FACTURA DE VENTA</h1><p><strong>${escapeHtml(storeName)}</strong><br>Comprobante generado por el sistema</p></div><div class="invoice-meta"><h2>${escapeHtml(sale.invoiceNumber)}</h2><p>Fecha: ${formatDate(sale.date)}<br>Cliente: ${escapeHtml(sale.customer || "Cliente general")}<br>Vendedor: ${escapeHtml(sale.seller || "—")}</p></div></header>
    <table class="invoice-items"><thead><tr><th>PRODUCTO</th><th class="invoice-right">CANTIDAD</th><th class="invoice-right">PRECIO UNITARIO</th><th class="invoice-right">TOTAL</th></tr></thead><tbody><tr><td>${escapeHtml(sale.productName)}</td><td class="invoice-right">${sale.quantity}</td><td class="invoice-right">${money(sale.total / sale.quantity)}</td><td class="invoice-right">${money(sale.total)}</td></tr></tbody></table>
    <div class="invoice-summary"><div><span>Total de la venta</span><strong>${money(sale.total)}</strong></div><div><span>Cuota inicial pagada (20%)</span><strong>${money(sale.downPayment)}</strong></div><div><span>Saldo pendiente</span><strong>${money(sale.balance)}</strong></div><div><span>Plan de pago</span><strong>${sale.installmentCount} cuotas de ${money(sale.installmentAmount)}</strong></div><div class="invoice-total"><span>TOTAL</span><span>${money(sale.total)}</span></div></div>
    <div class="invoice-terms"><strong>Condiciones de pago</strong><p>Cuota inicial: ${money(sale.downPayment)}. Saldo: ${money(sale.balance)}, dividido en ${sale.installmentCount} cuotas de ${money(sale.installmentAmount)}.</p></div>
    <p class="invoice-thanks">¡Gracias por tu compra!</p></article>`;
}

function showInvoice(sale) {
  const dialog = byId("invoice-dialog");
  dialog.dataset.saleId = sale.id;
  byId("invoice-preview").innerHTML = invoiceMarkup(sale);
  dialog.showModal();
}

function printInvoice(sale) {
  const printWindow = window.open("", "_blank", "width=800,height=700");
  if (!printWindow) {
    showNotice("El navegador bloqueó la factura. Permite las ventanas emergentes para imprimir.", true);
    return;
  }
  const invoiceHtml = `<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Factura ${escapeHtml(sale.invoiceNumber)}</title><style>
    *{box-sizing:border-box}body{max-width:760px;margin:50px auto;padding:35px;color:#23283a;font:14px Arial,sans-serif}
    .invoice-paper-header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #5269e8;padding-bottom:20px}
    .invoice-paper h1{font-size:24px;margin:0 0 8px}.invoice-paper h2{font-size:20px;color:#5269e8;margin:0}
    .invoice-paper p{color:#626879;line-height:1.7}.invoice-meta{text-align:right}.invoice-items{width:100%;border-collapse:collapse;margin:30px 0}
    .invoice-items th,.invoice-items td{text-align:left;padding:13px 10px;border-bottom:1px solid #e8eaf0}.invoice-items th{color:#73798a;font-size:11px}
    .invoice-right{text-align:right!important}.invoice-summary{margin-left:auto;width:300px}.invoice-summary div{display:flex;justify-content:space-between;padding:7px 0}
    .invoice-total{border-top:2px solid #5269e8;margin-top:5px;padding-top:12px!important;font-weight:bold;font-size:17px}
    .invoice-terms{margin-top:35px;padding:15px;background:#f5f6fa}.invoice-thanks{text-align:center;margin-top:40px}
    @media print{body{margin:0 auto;padding:25px}}
  </style></head><body>${invoiceMarkup(sale)}<script>window.addEventListener("load",()=>window.print());<\/script></body></html>`;
  printWindow.document.open();
  printWindow.document.write(invoiceHtml);
  printWindow.document.close();
}

function bindInvoiceDialog() {
  const dialog = byId("invoice-dialog");
  const closeDialog = () => dialog.close();
  byId("invoice-close").addEventListener("click", closeDialog);
  byId("invoice-cancel").addEventListener("click", closeDialog);
  byId("invoice-print").addEventListener("click", () => {
    const sale = sales.find((item) => item.id === dialog.dataset.saleId);
    if (sale) printInvoice(sale);
  });
}

function bindForms() {
  byId("purchase-form").addEventListener("submit", handlePurchase);
  byId("sale-form").addEventListener("submit", handleSale);
  byId("expense-form").addEventListener("submit", handleExpense);
  byId("purchase-form").addEventListener("input", updatePurchaseTotal);
  byId("sale-form").addEventListener("input", updateSaleCalculation);
  byId("sale-product").addEventListener("change", updateSaleCalculation);
}

async function initialize() {
  bindThemeToggle();
  setDefaultDates();
  bindNavigation();
  bindForms();
  bindAuthentication();
  bindInvoiceDialog();
  try {
    const session = await apiRequest("/api/session");
    if (typeof session.storesConfigured !== "boolean" || !("user" in session)) {
      throw new Error("El servidor abierto no tiene activa la API de la tienda. Inicia la app con npm start y abre la dirección que muestra la terminal.");
    }
    const { user } = session;
    if (user) {
      await enterApplication(user);
    } else {
      showAuthentication();
    }
  } catch (error) {
    showAuthentication(`No se pudo conectar con el servidor: ${error.message}`);
  }
}

initialize();
