/* ── Sentinels Client Portal · client types ──────────────────────────
   The advisor picks a client type in the admin panel (profile.client_type)
   and each type gets its own portal experience: navigation, dashboard
   widgets, default layout, look and Sentinel One wording.
     supply  Supply client (CFE basic service or Qualified Supply): full portal.
     trader  Comercializador: Dashboard, Sentinel One, Market Intelligence, Market Prices, MEM Insights, Documents.
     guest   Invitado: same experience as a trader, for trials with external users.
   To add a feature for traders in a later stage, add its section to `nav`
   and its widgets to `cats` / `widgets` / `layout` below.
   Uses the global ME (index.html). */
const Profiles = (() => {
  const TYPES = {
    supply: {
      label: 'Supply client', tag: 'Client Portal', theme: '',
      nav: ['dashboard', 'sites', 'assistant', 'intelligence', 'prices', 'contract', 'documents', 'support'],
      cats: ['Plants & bills', 'Key figures', 'Charts', 'Market', 'Contract', 'Updates'], widgets: [],
      title: 'Your dashboard', sub: 'Add, arrange and resize the widgets you care about'
    },
    trader: {
      label: 'Trader', tag: 'Trader Portal', theme: 'cp-theme-trader',
      nav: ['dashboard', 'assistant', 'intelligence', 'prices', 'insights', 'documents', 'support'],
      cats: ['Workspace', 'Market', 'Updates'], widgets: ['advisor'], recat: { advisor: 'Workspace' },
      title: 'Trading desk', sub: 'Market intelligence, documents and Sentinel One in one place',
      layout: [['ws_welcome', 'l'], ['kpi_intel_count', 's'], ['kpi_latest_update', 'm'], ['kpi_docs_count', 's'], ['ws_ask', 'w'], ['advisor', 's'], ['intel_list', 'w'], ['docs_recent', 'w']]
    },
    guest: {
      label: 'Guest', tag: 'Guest Access', theme: 'cp-theme-trader cp-theme-guest',
      nav: ['dashboard', 'assistant', 'intelligence', 'prices', 'insights', 'documents', 'support'],
      cats: ['Workspace', 'Market', 'Updates'], widgets: ['advisor'], recat: { advisor: 'Workspace' },
      title: 'Welcome to Sentinels', sub: 'Explore market intelligence, documents and Sentinel One',
      banner: 'You are using a guest account to explore the Sentinels platform. Contact your Sentinel advisor for full access.',
      layout: [['ws_welcome', 'l'], ['kpi_intel_count', 's'], ['kpi_latest_update', 'm'], ['kpi_docs_count', 's'], ['ws_ask', 'w'], ['advisor', 's'], ['intel_list', 'w'], ['docs_recent', 'w']]
    }
  };
  const type = () => { const t = typeof ME !== 'undefined' && ME && ME.profile && ME.profile.client_type; return TYPES[t] ? t : 'supply'; };
  const current = () => TYPES[type()];
  const isSupply = () => type() === 'supply';
  // A board widget is offered when its category (or the widget itself) belongs to this client type
  const offers = (id, cat) => current().cats.includes(cat) || current().widgets.includes(id);
  const allows = section => current().nav.includes(section);
  // Gallery heading for a widget (recat moves a widget to another heading for this type)
  const catOf = (id, cat) => (current().recat || {})[id] || cat;
  return { TYPES, type, current, isSupply, offers, allows, catOf };
})();
