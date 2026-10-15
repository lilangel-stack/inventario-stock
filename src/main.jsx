import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { gsap } from "gsap";
import "./index.css";

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
const VIEWS = {
  inicio: "Resumen del negocio",
  compras: "Compras a proveedores",
  ventas: "Registrar una venta",
  inventario: "Inventario",
  gastos: "Gastos y pagos",
  facturas: "Facturas de venta",
};
const NAVIGATION = [
  ["inicio", "⌂", "Resumen"],
  ["compras", "＋", "Compras"],
  ["ventas", "↗", "Nueva venta"],
  ["inventario", "▤", "Inventario"],
  ["gastos", "↙", "Gastos y pagos"],
  ["facturas", "▧", "Facturas"],
];
const EMPTY_DATA = { products: [], purchases: [], sales: [], expenses: [] };
const THEME_STORAGE_KEY = "mi-negocio-theme";
const LEGACY_MIGRATION_STORAGE_KEY = "mi-negocio-legacy-migrated-v1";
const money = (amount) => CURRENCY.format(Number(amount) || 0);
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const formatDate = (date) => date ? DATE_FORMAT.format(new Date(`${date}T12:00:00`)) : "—";
const makeId = () => crypto.randomUUID();

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
  const contentType = response.headers.get("content-type") || "";
  if (apiPath && !contentType.toLowerCase().includes("application/json")) {
    throw new Error(response.status === 405
      ? "El servidor abierto no admite el registro ni el inicio de sesión. Inicia la app con npm start; no abras index.html directamente."
      : "El servidor abierto no tiene activa la API de la tienda. Inicia la app con npm start y abre la dirección que muestra la terminal.");
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("El servidor respondió con datos inválidos. Inicia de nuevo la app con npm start.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("El servidor respondió con datos inválidos. Inicia de nuevo la app con npm start.");
  }
  if (!response.ok) {
    const error = new Error(result.error || `La solicitud falló (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function openLegacyDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("mi-negocio-db", 1);
    request.onupgradeneeded = () => {
      for (const name of ["products", "purchases", "sales", "expenses"]) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: "id" });
        }
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error("No se pudo abrir la base de datos anterior."));
    request.onblocked = () => reject(new Error("Cierra otras pestañas de esta app e inténtalo de nuevo."));
  });
}

function readLegacyStore(database, name) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(name, "readonly").objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudieron leer los datos antiguos."));
  });
}

function Brand({ storeName = "Mi negocio", initial = "M", auth = false }) {
  return (
    <a className={`brand ${auth ? "auth-brand" : ""}`} href={auth ? "/" : "#inicio"} aria-label={auth ? "Mi negocio" : "Ir al inicio"}>
      <span className="brand-mark">{initial}</span>
      <span>
        {auth ? <>mi<span className="brand-light">negocio</span></> : <span className="store-name">{storeName}</span>}
        <small>GESTIÓN COMERCIAL</small>
      </span>
    </a>
  );
}

function AuthScreen({ onAuthenticate, initialError }) {
  const [mode, setMode] = useState("login");
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const cardRef = useRef(null);
  const registering = mode === "register";

  useLayoutEffect(() => {
    const motion = gsap.matchMedia();
    motion.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(cardRef.current, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.55, ease: "power2.out" });
    });
    return () => motion.revert();
  }, [mode]);

  function switchMode() {
    setMode((current) => current === "register" ? "login" : "register");
    setError("");
    setVisiblePasswords({});
  }

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (registering && values.password !== values.confirmPassword) {
      setError("Las claves no coinciden.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onAuthenticate(registering ? "/api/register" : "/api/login", {
        password: values.password,
        ...(registering && {
          firstName: values.firstName,
          lastName: values.lastName,
          storeName: values.storeName,
        }),
      });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function passwordField(label, name, minLength, placeholder, autocomplete) {
    const visible = Boolean(visiblePasswords[name]);
    return (
      <label key={name}>
        {label}
        <span className="password-control">
          <input
            name={name}
            type={visible ? "text" : "password"}
            autoComplete={autocomplete}
            minLength={minLength}
            maxLength={128}
            placeholder={placeholder}
            required
            onChange={() => setError("")}
          />
          <button
            className="password-toggle"
            type="button"
            aria-label={`${visible ? "Ocultar" : "Mostrar"} ${name === "password" ? "clave especial" : "confirmación de clave especial"}`}
            aria-pressed={visible}
            onClick={() => setVisiblePasswords((current) => ({ ...current, [name]: !current[name] }))}
          >
            {visible ? "Ocultar" : "Mostrar"}
          </button>
        </span>
      </label>
    );
  }

  return (
    <main className="auth-screen min-h-screen grid place-items-center" aria-busy={busy}>
      <section className="auth-card" aria-labelledby="auth-title" ref={cardRef}>
        <Brand auth />
        <p className="auth-eyebrow">TU NEGOCIO, SIEMPRE CONTIGO</p>
        <h1 id="auth-title">{registering ? "Crea tu tienda" : "Accede a tu tienda"}</h1>
        <p className="auth-description">
          {registering
            ? "Ingresa tus datos y crea una clave privada para esta tienda independiente."
            : "Escribe la clave especial de la tienda a la que quieres acceder."}
        </p>
        <form onSubmit={submit} onChange={() => setError("")}>
          {registering && (
            <div className="grid gap-3.5">
              <label>Nombre<input name="firstName" autoComplete="given-name" maxLength={80} placeholder="Tu nombre" required /></label>
              <label>Apellido<input name="lastName" autoComplete="family-name" maxLength={80} placeholder="Tu apellido" required /></label>
              <label>Nombre de la tienda<input name="storeName" autoComplete="organization" maxLength={80} placeholder="Ej. Tienda La Esquina" required /></label>
            </div>
          )}
          {passwordField(
            "Clave especial de acceso",
            "password",
            registering ? 12 : 8,
            registering ? "Crea una clave segura de 12 caracteres o más" : "Clave privada de acceso a la tienda",
            registering ? "new-password" : "current-password",
          )}
          {registering && passwordField("Confirmar clave especial", "confirmPassword", 12, "Confirma tu clave especial", "new-password")}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>
            {busy ? (registering ? "Creando tienda…" : "Abriendo tienda…") : registering ? "Crear tienda y clave" : "Entrar a mi tienda"}
          </button>
        </form>
        <p className="auth-switch-copy">
          {registering ? "¿Ya tienes una tienda? " : "¿Quieres crear otra tienda? "}
          <button className="auth-switch" type="button" onClick={switchMode}>{registering ? "Iniciar sesión" : "Crear otra tienda"}</button>
        </p>
        <p className="auth-privacy">
          {registering
            ? "Cada tienda tiene sus propios datos y clave. Guarda la clave privada: no se puede recuperar."
            : "Cada clave abre una tienda independiente. Comparte la clave solo con personas autorizadas."}
        </p>
      </section>
    </main>
  );
}

function EmptyRow({ children, columns }) {
  return <tr className="empty-row"><td colSpan={columns}>{children}</td></tr>;
}

function DataTable({ headings, children }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function SectionIntro({ title, children, action }) {
  return (
    <div className={`section-intro ${action ? "section-heading-row" : ""}`}>
      <div><h2>{title}</h2><p>{children}</p></div>
      {action}
    </div>
  );
}

function Dashboard({ data, onNavigate }) {
  const { products, purchases, sales, expenses } = data;
  const revenue = sales.reduce((sum, sale) => sum + sale.total, 0);
  const investment = purchases.reduce((sum, purchase) => sum + purchase.total, 0);
  const soldCost = sales.reduce((sum, sale) => sum + sale.cost, 0);
  const saleCosts = sales.reduce((sum, sale) => sum + sale.commission + sale.delivery, 0);
  const otherExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const totalExpenses = saleCosts + otherExpenses;
  const profit = revenue - soldCost - totalExpenses;
  const inventoryValue = products.reduce((sum, product) => sum + product.stock * product.unitCost, 0);
  const stockCount = products.reduce((sum, product) => sum + product.stock, 0);
  const receivable = sales.reduce((sum, sale) => sum + sale.balance, 0);
  const soldByProduct = new Map();
  for (const sale of sales) soldByProduct.set(sale.productName, (soldByProduct.get(sale.productName) || 0) + sale.quantity);
  const rankedProducts = [...soldByProduct.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"));
  const lowStock = products.filter((product) => product.stock <= 3);
  const activity = [
    ...sales.map((sale) => ({ type: "Venta", detail: `${sale.productName} · ${sale.quantity} uds.`, date: sale.date, total: sale.total, className: "" })),
    ...purchases.map((purchase) => ({ type: "Compra", detail: `${purchase.productName} · ${purchase.quantity} uds.`, date: purchase.date, total: purchase.total, className: "purchase" })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const financial = [
    { label: "Ventas", amount: revenue, className: "sales" },
    { label: "Gastos", amount: totalExpenses, className: "expenses" },
    { label: "Diferencia", amount: revenue - totalExpenses, className: revenue < totalExpenses ? "negative" : "difference" },
  ];
  const maxAmount = Math.max(...financial.map(({ amount }) => Math.abs(amount)), 1);

  return (
    <section className="view active" aria-label="Resumen">
      <div className="welcome-row">
        <div><h2>Así va tu negocio</h2><p>Un vistazo rápido a tus ventas, inventario y ganancias.</p></div>
        <span className="today-chip">{DATE_FORMAT.format(new Date())}</span>
      </div>
      <div className="metric-grid">
        <Metric label="VENTAS REGISTRADAS" value={money(revenue)} foot={`${sales.length} ${sales.length === 1 ? "venta" : "ventas"}`} icon="↗" tone="blue" />
        <Metric label="INVERSIÓN EN COMPRAS" value={money(investment)} foot="Total comprado a proveedores" icon="◈" tone="purple" />
        <Metric label="UTILIDAD NETA" value={money(profit)} foot="Ventas − costo − gastos" icon="⌁" tone="green" />
        <Metric label="VALOR DEL INVENTARIO" value={money(inventoryValue)} foot={`${stockCount} ${stockCount === 1 ? "unidad" : "unidades"} en stock`} icon="▤" tone="orange" />
      </div>
      <div className="dashboard-charts">
        <article className="panel chart-panel">
          <PanelHeading title="Ventas, gastos y diferencia" detail="Comparación acumulada de los registros de tu tienda." />
          <div className="chart-content" role="img" aria-label="Gráfico de ventas, gastos y diferencia">
            {financial.map(({ label, amount, className }) => (
              <div className="chart-row" key={label}>
                <div className="chart-row-label"><span>{label}</span><strong>{amount < 0 ? "−" : ""}{money(Math.abs(amount))}</strong></div>
                <div className="chart-bar-track"><span className={`chart-bar ${className}`} style={{ width: `${Math.min(100, Math.abs(amount) / maxAmount * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </article>
        <article className="panel chart-panel">
          <PanelHeading title="Productos más vendidos" detail="Unidades vendidas por producto." />
          <div className="chart-content" role="img" aria-label="Gráfico de los productos más vendidos">
            {rankedProducts.length === 0
              ? <p className="chart-empty">Registra ventas para ver los productos más vendidos.</p>
              : rankedProducts.slice(0, 5).map(([name, quantity], index) => (
                <div className="chart-row product-chart-row" key={name}>
                  <div className="chart-row-label"><span className="chart-product-name"><b>{index + 1}</b>{name}</span><strong>{quantity} {quantity === 1 ? "ud." : "uds."}</strong></div>
                  <div className="chart-bar-track"><span className={`chart-bar product product-${index + 1}`} style={{ width: `${quantity / rankedProducts[0][1] * 100}%` }} /></div>
                </div>
              ))}
          </div>
        </article>
      </div>
      <div className="dashboard-grid">
        <article className="panel">
          <div className="panel-heading"><div><h3>Actividad reciente</h3><p>Las últimas compras y ventas registradas.</p></div><button className="text-button" onClick={() => onNavigate("facturas")}>Ver facturas →</button></div>
          <DataTable headings={["TIPO", "DETALLE", "FECHA", "VALOR"]}>
            {activity.length
              ? activity.map((item, index) => <tr key={`${item.type}-${index}`}><td><span className={`type-pill ${item.className}`}>{item.type}</span></td><td>{item.detail}</td><td>{formatDate(item.date)}</td><td className="align-right">{money(item.total)}</td></tr>)
              : <EmptyRow columns={4}>Registra tu primera compra o venta para ver actividad.</EmptyRow>}
          </DataTable>
        </article>
        <article className="panel insight-panel">
          <div className="panel-heading"><div><h3>Lo más importante</h3><p>Indicadores de tus productos.</p></div><span className="sparkle">✳</span></div>
          <div className="insight-item"><span className="insight-icon best-icon">★</span><span><small>PRODUCTO MÁS VENDIDO</small><strong>{rankedProducts[0]?.[0] || "Aún no hay ventas"}</strong></span><b>{rankedProducts[0] ? `${rankedProducts[0][1]} uds.` : "—"}</b></div>
          <div className="insight-item"><span className="insight-icon stock-icon">!</span><span><small>STOCK BAJO</small><strong>{lowStock.length ? `${lowStock.length} ${lowStock.length === 1 ? "producto" : "productos"} con 3 unidades o menos` : "Sin alertas"}</strong></span><button className="text-button" onClick={() => onNavigate("inventario")}>Revisar</button></div>
          <div className="insight-total"><span>Gastos y pagos registrados</span><strong>{money(totalExpenses)}</strong></div>
          <div className="insight-total"><span>Por cobrar en cuotas</span><strong>{money(receivable)}</strong></div>
        </article>
      </div>
    </section>
  );
}

function Metric({ label, value, foot, icon, tone }) {
  return <article className="metric-card"><span className="metric-label">{label}</span><span className="metric-value">{value}</span><span className="metric-foot">{foot}</span><span className={`metric-icon icon-${tone}`}>{icon}</span></article>;
}

function PanelHeading({ title, detail }) {
  return <div className="panel-heading"><div><h3>{title}</h3><p>{detail}</p></div></div>;
}

function PurchaseForm({ products, onSave, saving }) {
  const formRef = useRef(null);
  const [total, setTotal] = useState(0);
  function updateTotal(event) {
    const values = new FormData(event.currentTarget);
    setTotal((Number(values.get("quantity")) || 0) * (Number(values.get("unitCost")) || 0));
  }
  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const name = String(values.product).trim();
    const supplier = String(values.supplier).trim();
    const quantity = Number(values.quantity);
    const unitCost = Number(values.unitCost);
    if (!name || !Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(unitCost) || unitCost <= 0) {
      onSave(null, "Verifica el producto, la cantidad y el costo de la compra.");
      return;
    }
    const existing = products.find((product) => product.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es"));
    const oldQuantity = existing?.stock || 0;
    const newQuantity = oldQuantity + quantity;
    const product = {
      id: existing?.id || makeId(),
      name,
      supplier: supplier || existing?.supplier || "",
      stock: newQuantity,
      unitCost: Math.round(((oldQuantity * (existing?.unitCost || 0) + quantity * unitCost) / newQuantity) * 100) / 100,
    };
    const purchase = {
      id: makeId(),
      productId: product.id,
      productName: name,
      supplier,
      quantity,
      unitCost,
      total: Math.round(quantity * unitCost * 100) / 100,
      date: String(values.date),
    };
    const result = await onSave([
      { store: "products", value: product },
      { store: "purchases", value: purchase },
    ], `Compra guardada. Se agregaron ${quantity} unidades de ${name} al inventario.`);
    if (result) {
      form.reset();
      setTotal(0);
      form.elements.date.value = today();
    }
  }
  return (
    <>
      <SectionIntro title="Registrar compra">Ingresa los productos recibidos del proveedor para actualizar automáticamente tu inventario.</SectionIntro>
      <form className="panel form-panel" onSubmit={submit} onInput={updateTotal} ref={formRef}>
        <FormSection step="1" title="Datos de la compra" detail="La compra quedará guardada en el historial de inversión." />
        <div className="form-grid">
          <label>Nombre del producto<input name="product" required maxLength={80} placeholder="Ej. Camiseta básica" /></label>
          <label>Proveedor<input name="supplier" maxLength={80} placeholder="Nombre del proveedor" /></label>
          <label>Cantidad recibida<input name="quantity" type="number" min="1" step="1" required placeholder="0" /></label>
          <label>Costo por unidad<input name="unitCost" type="number" min="0.01" step="0.01" required placeholder="0" /></label>
          <label className="field-wide">Fecha de compra<input name="date" type="date" defaultValue={today()} required /></label>
        </div>
        <div className="form-summary"><span>Inversión de esta compra</span><strong>{money(total)}</strong></div>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={saving}>Guardar compra</button></div>
      </form>
    </>
  );
}

function FormSection({ step, title, detail }) {
  return <div className="form-section-title"><span className="step-number">{step}</span><div><h3>{title}</h3><p>{detail}</p></div></div>;
}

function SaleForm({ products, onSave, saving }) {
  const [values, setValues] = useState({ productId: "", quantity: "1", margin: "30", seller: "", commission: "0", delivery: "0", installments: "4", customer: "" });
  const calculation = useMemo(() => {
    const product = products.find((item) => item.id === values.productId);
    const quantity = Math.max(0, Number(values.quantity) || 0);
    const margin = Math.max(0, Number(values.margin) || 0);
    const installmentCount = Math.max(1, Number(values.installments) || 1);
    const cost = product ? product.unitCost * quantity : 0;
    const total = Math.round(cost * (1 + margin / 100) * 100) / 100;
    const downPayment = Math.round(total * 0.2 * 100) / 100;
    const balance = Math.round((total - downPayment) * 100) / 100;
    return { product, quantity, margin, installmentCount, cost, total, downPayment, balance };
  }, [products, values]);
  function update(event) {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
  }
  async function submit(event) {
    event.preventDefault();
    const { product, quantity, margin, installmentCount, cost, total, downPayment, balance } = calculation;
    if (!product || quantity < 1 || !Number.isInteger(quantity)) {
      onSave(null, "Selecciona un producto e ingresa una cantidad entera válida.");
      return;
    }
    if (quantity > product.stock) {
      onSave(null, `Stock insuficiente. Solo hay ${product.stock} unidades disponibles.`);
      return;
    }
    const commission = Number(values.commission) || 0;
    const delivery = Number(values.delivery) || 0;
    if (commission < 0 || delivery < 0) {
      onSave(null, "La comisión y el pago al repartidor no pueden ser negativos.");
      return;
    }
    const invoiceNumber = `FAC-${new Date().getFullYear()}-${makeId().slice(0, 8).toUpperCase()}`;
    const sale = {
      id: makeId(),
      invoiceNumber,
      productId: product.id,
      productName: product.name,
      quantity,
      unitCost: product.unitCost,
      cost: Math.round(cost * 100) / 100,
      margin,
      total,
      downPayment,
      balance,
      installmentCount,
      installmentAmount: Math.round((balance / installmentCount) * 100) / 100,
      seller: values.seller.trim(),
      commission: Math.round(commission * 100) / 100,
      delivery: Math.round(delivery * 100) / 100,
      customer: values.customer.trim(),
      date: today(),
    };
    const updatedProduct = { ...product, stock: product.stock - quantity };
    const result = await onSave([
      { store: "products", value: updatedProduct },
      { store: "sales", value: sale },
    ], `Venta guardada. Se generó la factura ${invoiceNumber}; puedes consultarla e imprimirla aquí.`, "facturas");
    if (result) setValues({ productId: "", quantity: "1", margin: "30", seller: "", commission: "0", delivery: "0", installments: "4", customer: "" });
  }
  return (
    <>
      <SectionIntro title="Nueva venta">Calcula el precio, el pago inicial y las cuotas antes de guardar la venta.</SectionIntro>
      <form className="panel form-panel" onSubmit={submit} onChange={update}>
        <FormSection step="1" title="Producto y precio" detail="El precio de venta se calcula sobre el costo promedio del inventario." />
        <div className="form-grid">
          <label>Producto<select name="productId" value={values.productId} required><option value="">Selecciona un producto</option>{[...products].sort((a, b) => a.name.localeCompare(b.name, "es")).map((product) => <option value={product.id} disabled={product.stock < 1} key={product.id}>{product.name} · {product.stock} uds. · {money(product.unitCost)}</option>)}</select></label>
          <label>Cantidad<input name="quantity" type="number" min="1" step="1" value={values.quantity} required /></label>
          <label>Utilidad sobre el costo (%)<input name="margin" type="number" min="0" step="0.01" value={values.margin} required /></label>
          <label>Vendedor<input name="seller" maxLength={80} placeholder="Nombre del vendedor" value={values.seller} /></label>
          <label>Comisión del vendedor<input name="commission" type="number" min="0" step="0.01" value={values.commission} /></label>
          <label>Pago al repartidor<input name="delivery" type="number" min="0" step="0.01" value={values.delivery} /></label>
          <label>Número de cuotas<input name="installments" type="number" min="1" max="120" step="1" value={values.installments} required /></label>
          <label>Cliente (opcional)<input name="customer" maxLength={100} placeholder="Nombre del cliente" value={values.customer} /></label>
        </div>
        <div className="calculation-box">
          <div><span>Costo de la venta</span><strong>{money(calculation.cost)}</strong></div>
          <div><span>Precio de venta</span><strong>{money(calculation.total)}</strong></div>
          <div><span>Cuota inicial (20%)</span><strong>{money(calculation.downPayment)}</strong></div>
          <div><span>Cuotas restantes</span><strong>{money(calculation.balance / calculation.installmentCount)}</strong><small>{calculation.installmentCount} {calculation.installmentCount === 1 ? "cuota" : "cuotas"}</small></div>
          <p>{calculation.product
            ? `${calculation.product.stock} unidades disponibles${calculation.quantity > calculation.product.stock ? " · Cantidad superior al stock disponible" : ""}. La cuota inicial es el 20% del precio de venta.`
            : "Selecciona un producto para consultar el stock."}</p>
        </div>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={saving}>Guardar venta y generar factura</button></div>
      </form>
    </>
  );
}

function Inventory({ products, onNavigate }) {
  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name, "es"));
  return (
    <>
      <SectionIntro title="Inventario" action={<button className="button button-primary" onClick={() => onNavigate("compras")}>＋ Registrar compra</button>}>Existencias y costo promedio de tus productos.</SectionIntro>
      <article className="panel"><DataTable headings={["PRODUCTO", "PROVEEDOR", "COSTO PROMEDIO", "UNIDADES", "VALOR EN STOCK"]}>
        {sorted.length
          ? sorted.map((product) => <tr key={product.id}><td><strong>{product.name}</strong></td><td>{product.supplier || "—"}</td><td className="align-right">{money(product.unitCost)}</td><td className="align-right">{product.stock}{product.stock <= 3 && <> <span className="type-pill purchase">Stock bajo</span></>}</td><td className="align-right">{money(product.stock * product.unitCost)}</td></tr>)
          : <EmptyRow columns={5}>Todavía no hay productos. Registra una compra para iniciar tu inventario.</EmptyRow>}
      </DataTable></article>
    </>
  );
}

function Expenses({ data, onSave, saving }) {
  const { expenses, sales } = data;
  const rows = [
    ...expenses.map((expense) => ({ category: expense.category, description: expense.description, date: expense.date, amount: expense.amount, id: expense.id })),
    ...sales.filter((sale) => sale.commission > 0).map((sale) => ({ category: "Comisión", description: `${sale.seller || "Vendedor"} · Factura ${sale.invoiceNumber}`, date: sale.date, amount: sale.commission, id: `${sale.id}-commission` })),
    ...sales.filter((sale) => sale.delivery > 0).map((sale) => ({ category: "Reparto", description: `Factura ${sale.invoiceNumber}`, date: sale.date, amount: sale.delivery, id: `${sale.id}-delivery` })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const amount = Number(values.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      onSave(null, "Ingresa un valor mayor que cero para el gasto.");
      return;
    }
    const expense = { id: makeId(), category: String(values.category), description: String(values.description).trim(), amount: Math.round(amount * 100) / 100, date: String(values.date) };
    if (await onSave([{ store: "expenses", value: expense }], "El gasto o pago quedó guardado correctamente.")) {
      form.reset();
      form.elements.date.value = today();
    }
  }
  return (
    <>
      <SectionIntro title="Gastos y pagos">Registra nómina, gastos operativos y otros pagos de tu negocio.</SectionIntro>
      <form className="panel form-panel compact-form" onSubmit={submit}>
        <FormSection step="＋" title="Agregar un gasto o pago" detail="Las comisiones y repartos de las ventas se incluyen automáticamente." />
        <div className="form-grid">
          <label>Concepto<select name="category" required><option value="Nómina">Pago de nómina</option><option value="Gasto operativo">Gasto operativo</option><option value="Arriendo">Arriendo</option><option value="Servicios">Servicios</option><option value="Otro">Otro pago</option></select></label>
          <label>Descripción<input name="description" required maxLength={120} placeholder="Ej. Nómina primera quincena" /></label>
          <label>Valor<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0" /></label>
          <label>Fecha<input name="date" type="date" defaultValue={today()} required /></label>
        </div>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={saving}>Guardar gasto</button></div>
      </form>
      <article className="panel expense-history">
        <PanelHeading title="Historial de gastos" detail="Incluye pagos y gastos operativos guardados." />
        <DataTable headings={["CONCEPTO", "DESCRIPCIÓN", "FECHA", "VALOR"]}>
          {rows.length
            ? rows.map((expense) => <tr key={expense.id}><td>{expense.category}</td><td>{expense.description}</td><td>{formatDate(expense.date)}</td><td className="align-right">{money(expense.amount)}</td></tr>)
            : <EmptyRow columns={4}>Aún no has registrado gastos ni pagos.</EmptyRow>}
        </DataTable>
      </article>
    </>
  );
}

function Invoices({ sales, onViewInvoice }) {
  const sorted = [...sales].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <SectionIntro title="Facturas de venta">Consulta e imprime las facturas generadas al registrar cada venta.</SectionIntro>
      <article className="panel"><DataTable headings={["FACTURA", "CLIENTE / VENDEDOR", "FECHA", "TOTAL", "ACCIONES"]}>
        {sorted.length
          ? sorted.map((sale) => <tr key={sale.id}><td><strong>{sale.invoiceNumber}</strong></td><td>{sale.customer || "Cliente"}{sale.seller ? ` · ${sale.seller}` : ""}</td><td>{formatDate(sale.date)}</td><td className="align-right">{money(sale.total)}</td><td className="align-right"><button className="invoice-button" onClick={() => onViewInvoice(sale)}>Ver factura</button></td></tr>)
          : <EmptyRow columns={5}>Las facturas aparecerán aquí cuando registres una venta.</EmptyRow>}
      </DataTable></article>
    </>
  );
}

function InvoicePaper({ sale, storeName }) {
  return (
    <article className="invoice-paper">
      <header className="invoice-paper-header">
        <div><h1>FACTURA DE VENTA</h1><p><strong>{storeName || "Mi negocio"}</strong><br />Comprobante generado por el sistema</p></div>
        <div className="invoice-meta"><h2>{sale.invoiceNumber}</h2><p>Fecha: {formatDate(sale.date)}<br />Cliente: {sale.customer || "Cliente general"}<br />Vendedor: {sale.seller || "—"}</p></div>
      </header>
      <table className="invoice-items"><thead><tr><th>PRODUCTO</th><th className="invoice-right">CANTIDAD</th><th className="invoice-right">PRECIO UNITARIO</th><th className="invoice-right">TOTAL</th></tr></thead>
        <tbody><tr><td>{sale.productName}</td><td className="invoice-right">{sale.quantity}</td><td className="invoice-right">{money(sale.total / sale.quantity)}</td><td className="invoice-right">{money(sale.total)}</td></tr></tbody>
      </table>
      <div className="invoice-summary">
        <div><span>Total de la venta</span><strong>{money(sale.total)}</strong></div>
        <div><span>Cuota inicial pagada (20%)</span><strong>{money(sale.downPayment)}</strong></div>
        <div><span>Saldo pendiente</span><strong>{money(sale.balance)}</strong></div>
        <div><span>Plan de pago</span><strong>{sale.installmentCount} cuotas de {money(sale.installmentAmount)}</strong></div>
        <div className="invoice-total"><span>TOTAL</span><span>{money(sale.total)}</span></div>
      </div>
      <div className="invoice-terms"><strong>Condiciones de pago</strong><p>Cuota inicial: {money(sale.downPayment)}. Saldo: {money(sale.balance)}, dividido en {sale.installmentCount} cuotas de {money(sale.installmentAmount)}.</p></div>
      <p className="invoice-thanks">¡Gracias por tu compra!</p>
    </article>
  );
}

const PRINT_STYLES = `
  *{box-sizing:border-box}body{max-width:760px;margin:50px auto;padding:35px;color:#23283a;font:14px Arial,sans-serif}
  .invoice-paper-header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #5269e8;padding-bottom:20px}
  .invoice-paper h1{font-size:24px;margin:0 0 8px}.invoice-paper h2{font-size:20px;color:#5269e8;margin:0}
  .invoice-paper p{color:#626879;line-height:1.7}.invoice-meta{text-align:right}.invoice-items{width:100%;border-collapse:collapse;margin:30px 0}
  .invoice-items th,.invoice-items td{text-align:left;padding:13px 10px;border-bottom:1px solid #e8eaf0}.invoice-items th{color:#73798a;font-size:11px}
  .invoice-right{text-align:right!important}.invoice-summary{margin-left:auto;width:300px}.invoice-summary div{display:flex;justify-content:space-between;padding:7px 0}
  .invoice-total{border-top:2px solid #5269e8;margin-top:5px;padding-top:12px!important;font-weight:bold;font-size:17px}
  .invoice-terms{margin-top:35px;padding:15px;background:#f5f6fa}.invoice-thanks{text-align:center;margin-top:40px}
  @media print{body{margin:0 auto;padding:25px}}
`;

function InvoiceDialog({ sale, storeName, onClose, onError }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!sale) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [sale]);
  function printInvoice() {
    const printWindow = window.open("", "_blank", "width=800,height=700");
    if (!printWindow) {
      onError("El navegador bloqueó la factura. Permite las ventanas emergentes para imprimir.");
      return;
    }
    const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
    const invoice = `<article class="invoice-paper"><header class="invoice-paper-header"><div><h1>FACTURA DE VENTA</h1><p><strong>${escape(storeName || "Mi negocio")}</strong><br>Comprobante generado por el sistema</p></div><div class="invoice-meta"><h2>${escape(sale.invoiceNumber)}</h2><p>Fecha: ${formatDate(sale.date)}<br>Cliente: ${escape(sale.customer || "Cliente general")}<br>Vendedor: ${escape(sale.seller || "—")}</p></div></header><table class="invoice-items"><thead><tr><th>PRODUCTO</th><th class="invoice-right">CANTIDAD</th><th class="invoice-right">PRECIO UNITARIO</th><th class="invoice-right">TOTAL</th></tr></thead><tbody><tr><td>${escape(sale.productName)}</td><td class="invoice-right">${sale.quantity}</td><td class="invoice-right">${money(sale.total / sale.quantity)}</td><td class="invoice-right">${money(sale.total)}</td></tr></tbody></table><div class="invoice-summary"><div><span>Total de la venta</span><strong>${money(sale.total)}</strong></div><div><span>Cuota inicial pagada (20%)</span><strong>${money(sale.downPayment)}</strong></div><div><span>Saldo pendiente</span><strong>${money(sale.balance)}</strong></div><div><span>Plan de pago</span><strong>${sale.installmentCount} cuotas de ${money(sale.installmentAmount)}</strong></div><div class="invoice-total"><span>TOTAL</span><span>${money(sale.total)}</span></div></div><div class="invoice-terms"><strong>Condiciones de pago</strong><p>Cuota inicial: ${money(sale.downPayment)}. Saldo: ${money(sale.balance)}, dividido en ${sale.installmentCount} cuotas de ${money(sale.installmentAmount)}.</p></div><p class="invoice-thanks">¡Gracias por tu compra!</p></article>`;
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Factura ${escape(sale.invoiceNumber)}</title><style>${PRINT_STYLES}</style></head><body>${invoice}<script>window.addEventListener("load",()=>window.print());<\/script></body></html>`);
    printWindow.document.close();
  }
  return (
    <dialog className="invoice-dialog" ref={dialogRef} aria-labelledby="invoice-dialog-title" onClose={onClose} onCancel={onClose}>
      {sale && <>
        <div className="invoice-dialog-header"><h2 id="invoice-dialog-title">Vista previa de factura</h2><button className="invoice-close" type="button" aria-label="Cerrar vista previa" onClick={onClose}>×</button></div>
        <div className="invoice-preview"><InvoicePaper sale={sale} storeName={storeName} /></div>
        <div className="invoice-dialog-actions"><button className="button invoice-cancel" type="button" onClick={onClose}>Cerrar</button><button className="button button-primary" type="button" onClick={printInvoice}>Imprimir factura</button></div>
      </>}
    </dialog>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [data, setData] = useState(EMPTY_DATA);
  const [isInitializing, setIsInitializing] = useState(true);
  const [authError, setAuthError] = useState("");
  const [activeView, setActiveView] = useState(() => VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "inicio");
  const [notice, setNotice] = useState(null);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
    } catch (error) {
      console.warn("No se pudo leer la preferencia de tema guardada.", error);
      return "light";
    }
  });
  const [selectedSale, setSelectedSale] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Conectando con tu tienda…");
  const shellRef = useRef(null);
  const viewRef = useRef(null);
  const noticeTimer = useRef(null);

  const showNotice = useCallback((message, isError = false) => {
    setNotice({ message, isError });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);

  const loadStoreData = useCallback(async () => {
    const { data: cloudData } = await apiRequest("/api/data");
    let migrationComplete = false;
    try {
      migrationComplete = localStorage.getItem(LEGACY_MIGRATION_STORAGE_KEY) === "true";
    } catch (error) {
      showNotice(`No se pudo comprobar si hay datos antiguos en este dispositivo: ${error.message}`, true);
      setData(cloudData);
      return;
    }
    if (migrationComplete) {
      setData(cloudData);
      return;
    }
    try {
      const legacyDatabase = await openLegacyDatabase();
      let legacyData;
      try {
        legacyData = Object.fromEntries(await Promise.all(
          ["products", "purchases", "sales", "expenses"].map(async (store) => [store, await readLegacyStore(legacyDatabase, store)]),
        ));
      } finally {
        legacyDatabase.close();
      }
      const cloudHasRecords = Object.values(cloudData).some((records) => records.length > 0);
      const legacyHasRecords = Object.values(legacyData).some((records) => records.length > 0);
      if (!cloudHasRecords && legacyHasRecords) {
        await apiRequest("/api/data", { method: "PUT", body: JSON.stringify({ data: legacyData }) });
        try {
          localStorage.setItem(LEGACY_MIGRATION_STORAGE_KEY, "true");
        } catch (error) {
          showNotice(`Tus datos se sincronizaron, pero no se pudo guardar la marca de migración local: ${error.message}`, true);
        }
        setData(legacyData);
        showNotice("Tus datos guardados anteriormente en este dispositivo ya están en tu tienda.");
        return;
      }
    } catch (error) {
      showNotice(`No se pudieron migrar los datos anteriores de este dispositivo: ${error.message}`, true);
      setData(cloudData);
      return;
    }
    try {
      localStorage.setItem(LEGACY_MIGRATION_STORAGE_KEY, "true");
    } catch (error) {
      showNotice(`No se pudo guardar la marca de migración local: ${error.message}`, true);
    }
    setData(cloudData);
  }, [showNotice]);

  const refreshData = useCallback(async () => {
    const { data: latest } = await apiRequest("/api/data");
    setData(latest);
  }, []);

  const enterApplication = useCallback(async (nextUser) => {
    setUser(nextUser);
    setLoadingMessage("Cargando los datos de tu tienda…");
    try {
      await loadStoreData();
      const requestedView = location.hash.slice(1);
      setActiveView(VIEWS[requestedView] ? requestedView : "inicio");
    } catch (error) {
      if (error.status === 401) {
        setUser(null);
        setAuthError("Tu sesión venció. Inicia sesión de nuevo para continuar.");
        return;
      }
      showNotice(`No se pudieron cargar los datos de tu tienda: ${error.message}`, true);
    }
  }, [loadStoreData, showNotice]);

  useEffect(() => {
    let mounted = true;
    apiRequest("/api/session").then(async (session) => {
      if (!mounted) return;
      setIsInitializing(false);
      if (typeof session.storesConfigured !== "boolean" || !("user" in session)) {
        throw new Error("El servidor abierto no tiene activa la API de la tienda. Inicia la app con npm start.");
      }
      if (session.user) {
        setAuthError("");
        await enterApplication(session.user);
      } else {
        setAuthError("");
        setLoadingMessage("");
      }
    }).catch((error) => {
      if (mounted) {
        setIsInitializing(false);
        setAuthError(`No se pudo conectar con el servidor: ${error.message}`);
      }
    });
    return () => { mounted = false; };
  }, [enterApplication]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === "dark" ? "#11141c" : "#f5f6f8";
    if (!user) return;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      showNotice(`El tema cambió, pero no se pudo guardar la preferencia: ${error.message}`, true);
    }
  }, [theme, user, showNotice]);

  useEffect(() => {
    if (!user) return undefined;
    const sync = () => {
      if (document.visibilityState !== "visible") return;
      refreshData().catch((error) => {
        if (error.status === 401) {
          setUser(null);
          setAuthError("Tu sesión venció. Inicia sesión de nuevo para continuar.");
        } else {
          showNotice(`No se pudieron sincronizar tus datos: ${error.message}`, true);
        }
      });
    };
    document.addEventListener("visibilitychange", sync);
    const interval = window.setInterval(sync, 30000);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.clearInterval(interval);
    };
  }, [user, refreshData, showNotice]);

  useLayoutEffect(() => {
    if (!user || !shellRef.current) return undefined;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const context = gsap.context(() => {
        gsap.fromTo(shellRef.current, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "power1.out" });
        gsap.fromTo(".metric-card", { opacity: 0, y: 14 }, {
          opacity: 1, y: 0, duration: 0.4, stagger: 0.08, ease: "power2.out", delay: 0.12,
        });
      }, shellRef);
      return () => context.revert();
    });
    return () => media.revert();
  }, [user]);

  useLayoutEffect(() => {
    if (!user || !viewRef.current) return undefined;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(viewRef.current, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.28, ease: "power1.out" });
    });
    return () => media.revert();
  }, [user, activeView]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  function navigate(view) {
    if (!VIEWS[view]) return;
    setActiveView(view);
    if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  }

  async function authenticate(endpoint, body) {
    const { user: authenticatedUser } = await apiRequest(endpoint, {
      method: "POST",
      body: JSON.stringify(body),
    });
    await enterApplication(authenticatedUser);
  }

  async function logout() {
    try {
      await apiRequest("/api/logout", { method: "POST" });
      setUser(null);
      setData(EMPTY_DATA);
      setLoadingMessage("");
    } catch (error) {
      showNotice(`No se pudo cerrar la sesión con el servidor: ${error.message}`, true);
    }
  }

  async function saveRecords(records, successMessage, nextView) {
    if (!records) {
      showNotice(successMessage, true);
      return false;
    }
    const stores = [...new Set(records.map(({ store }) => store))];
    const updatedData = Object.fromEntries(stores.map((store) => [
      store,
      records.filter((record) => record.store === store).map(({ value }) => value),
    ]));
    setSaving(true);
    try {
      await apiRequest("/api/data", { method: "PUT", body: JSON.stringify({ data: updatedData }) });
      await refreshData();
      if (nextView) navigate(nextView);
      showNotice(successMessage);
      return true;
    } catch (error) {
      showNotice(`No se pudo guardar: ${error.message}`, true);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const firstName = user?.firstName?.trim() || "bienvenido";
  const storeName = user?.storeName?.trim() || "Mi negocio";
  const initial = storeName.slice(0, 1).toLocaleUpperCase("es");

  if (!user) {
    if (isInitializing) {
      return <main className="auth-screen min-h-screen grid place-items-center"><section className="auth-card" role="status">{loadingMessage}</section></main>;
    }
    return <AuthScreen onAuthenticate={authenticate} initialError={authError} />;
  }

  let content;
  switch (activeView) {
    case "compras":
      content = <PurchaseForm products={data.products} onSave={saveRecords} saving={saving} />;
      break;
    case "ventas":
      content = <SaleForm products={data.products} onSave={saveRecords} saving={saving} />;
      break;
    case "inventario":
      content = <Inventory products={data.products} onNavigate={navigate} />;
      break;
    case "gastos":
      content = <Expenses data={data} onSave={saveRecords} saving={saving} />;
      break;
    case "facturas":
      content = <Invoices sales={data.sales} onViewInvoice={setSelectedSale} />;
      break;
    default:
      content = <Dashboard data={data} onNavigate={navigate} />;
  }

  return (
    <div className="app-shell" ref={shellRef}>
      <aside className="sidebar">
        <Brand storeName={storeName} initial={initial} />
        <span className="nav-caption">MENÚ PRINCIPAL</span>
        <nav className="nav-list" aria-label="Menú principal">
          {NAVIGATION.map(([view, icon, label]) => (
            <button className={`nav-link ${activeView === view ? "active" : ""}`} key={view} onClick={() => navigate(view)} aria-current={activeView === view ? "page" : undefined}>
              <span className="nav-icon" aria-hidden="true">{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-note"><span className="online-dot" /><span>Datos sincronizados en tu tienda<small>Accede con la clave desde tus dispositivos</small></span></div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div><p className="eyebrow">¡Te damos la bienvenida, {firstName}!</p><h1>{VIEWS[activeView]}</h1></div>
          <div className="top-actions">
            <span className="account-owner">{firstName}</span>
            <button className="logout-button" type="button" onClick={logout}>Cerrar sesión</button>
            <button className="theme-toggle" type="button" aria-label={`Cambiar a modo ${theme === "dark" ? "claro" : "oscuro"}`} title={`Cambiar a modo ${theme === "dark" ? "claro" : "oscuro"}`} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}>
              <span className="theme-icon" aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span><span>{theme === "dark" ? "Modo claro" : "Modo oscuro"}</span>
            </button>
            <button className="button button-primary top-action" onClick={() => navigate("ventas")}><span>＋</span> Registrar venta</button>
          </div>
        </header>
        {notice && <div className={`notice ${notice.isError ? "error" : ""}`} role={notice.isError ? "alert" : "status"} aria-live="polite">{notice.message}</div>}
        <div ref={viewRef} key={activeView}>
          {content}
        </div>
        <footer className="footer-note">Los datos se sincronizan con tu tienda. Para acceder desde otros dispositivos, mantén el servidor conectado y usa la misma clave especial.</footer>
      </main>
      <InvoiceDialog sale={selectedSale} storeName={storeName} onClose={() => setSelectedSale(null)} onError={(message) => showNotice(message, true)} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
