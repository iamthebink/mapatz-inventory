import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

type Role = 'guest' | 'operator' | 'admin';
type Item = { id: number; code: number; name: string; kind: 'consumable' | 'non_consumable'; lotSize: number | null; locationId: number | null; aliases: string[]; available: number; damaged: number; archived: boolean };
type Borrower = { id: number; username: string; name: string; contact: string; type: 'individual' | 'camp_organization' | 'other'; archived: boolean };
type Loan = { checkoutId: number; code: number; itemName: string; borrowerName: string; outstanding: number; lost: number };
type Location = { id: number; code: string; name: string; archived: boolean };
type Session = { role: Role; deadline: number | null };
type Tab = 'inventory' | 'checkout' | 'returns' | 'catalogs' | 'ledger';

const roleNames: Record<Role, string> = { guest: 'אורח', operator: 'מפעיל', admin: 'מנהל' };

function number(form: FormData, name: string): number { return Number(form.get(name)); }

export function App() {
  const [session, setSession] = useState<Session>({ role: 'guest', deadline: null });
  const [items, setItems] = useState<Item[]>([]);
  const [borrowers, setBorrowers] = useState<Borrower[]>([]);
  const [catalogItems, setCatalogItems] = useState<Item[]>([]);
  const [catalogBorrowers, setCatalogBorrowers] = useState<Borrower[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [ledger, setLedger] = useState<Record<string, any>[]>([]);
  const [tab, setTab] = useState<Tab>('inventory');
  const [query, setQuery] = useState('');
  const [operationQuery, setOperationQuery] = useState('');
  const [borrowerQuery, setBorrowerQuery] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [now, setNow] = useState(Date.now());
  const remaining = session.deadline == null ? null : Math.max(0, Math.ceil((session.deadline - now) / 1000));

  const refresh = useCallback(async () => {
    const [current, nextItems, nextBorrowers, nextLoans, allItems, allBorrowers, nextLocations] = await Promise.all([
      api<Session>('/session'), api<Item[]>('/items'),
      api<Borrower[]>('/borrowers'), api<Loan[]>('/loans'), api<Item[]>('/items?all=1'),
      api<Borrower[]>('/borrowers?all=1'), api<Location[]>('/locations?all=1'),
    ]);
    setSession(current); setItems(nextItems); setBorrowers(nextBorrowers); setLoans(nextLoans);
    setCatalogItems(allItems); setCatalogBorrowers(allBorrowers); setLocations(nextLocations);
    if (tab === 'ledger') setLedger(await api('/ledger'));
  }, [tab]);

  useEffect(() => { refresh().catch(showError); }, [refresh]);
  useEffect(() => {
    const auth = () => refresh().catch(showError);
    window.addEventListener('mapatz-auth-stale', auth);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('mapatz-auth-stale', auth); clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    if (remaining === 0 && session.role !== 'guest') refresh().catch(showError);
  }, [remaining, session.role, refresh]);
  useEffect(() => {
    let lastPing = 0;
    const activity = () => {
      if (session.role === 'guest' || Date.now() - lastPing < 5_000) return;
      lastPing = Date.now();
      api<Session>('/session').then(setSession).catch(showError);
    };
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    return () => { window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity); };
  }, [session.role]);

  const canOperate = session.role === 'operator' || session.role === 'admin';
  const isAdmin = session.role === 'admin';
  const filteredItems = useMemo(() => items.filter((item) => `${item.code} ${item.name} ${item.aliases.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [items, query]);
  const operationItems = useMemo(() => items.filter((item) => `${item.code} ${item.name} ${item.aliases.join(' ')}`.toLocaleLowerCase().includes(operationQuery.toLocaleLowerCase())), [items, operationQuery]);
  const operationBorrowers = useMemo(() => borrowers.filter((borrower) => `${borrower.name} ${borrower.username}`.toLocaleLowerCase().includes(borrowerQuery.toLocaleLowerCase())), [borrowers, borrowerQuery]);

  function showError(error: unknown) { setMessage(error instanceof Error ? error.message : 'הפעולה נכשלה'); }
  async function action(operation: () => Promise<unknown>) {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true);
    try {
      await operation();
      try { await refresh(); setMessage('הפעולה הושלמה'); }
      catch { setMessage('הפעולה הושלמה, אך התצוגה לא התרעננה. אין לחזור על הפעולה; יש לרענן את המסך.'); }
    } catch (error) { showError(error); }
    finally { pendingRef.current = false; setPending(false); }
  }
  async function changeRole(role: Role) {
    const upward = ({ guest: 0, operator: 1, admin: 2 })[role] > ({ guest: 0, operator: 1, admin: 2 })[session.role];
    const password = upward ? window.prompt(`סיסמה עבור מצב ${roleNames[role]}`) : undefined;
    if (upward && password === null) return;
    await action(async () => setSession(await api('/session/role', { method: 'POST', body: JSON.stringify({ role, password }) })));
  }

  function returnLoan(loan: Loan) {
    const usableText = prompt('כמות תקינה', String(loan.outstanding)); if (usableText === null) return;
    const damagedText = prompt('כמות פגומה', '0'); if (damagedText === null) return;
    const note = prompt('הערה (רשות)', ''); if (note === null) return;
    action(() => api('/return', { method: 'POST', body: JSON.stringify({ checkoutId: loan.checkoutId, usable: Number(usableText), damaged: Number(damagedText), note }) }));
  }

  function changeLost(loan: Loan, lost: boolean) {
    const maximum = lost ? loan.outstanding : loan.lost;
    const quantity = prompt(lost ? 'כמות לסימון כאבודה' : 'כמות לביטול אובדן', String(maximum)); if (quantity === null) return;
    const note = prompt('הערה (רשות)', ''); if (note === null) return;
    action(() => api('/lost', { method: 'POST', body: JSON.stringify({ checkoutId: loan.checkoutId, quantity: Number(quantity), lost, note }) }));
  }

  function editItem(item: Item) {
    const name = prompt('שם פריט', item.name); if (name === null) return;
    const aliasText = prompt('כינויים מופרדים בפסיק', item.aliases.join(',')); if (aliasText === null) return;
    const lotText = prompt('גודל מארז (ריק ללא מארז)', item.lotSize?.toString() ?? ''); if (lotText === null) return;
    const locationText = prompt(`מזהה מיקום (ריק ללא מיקום)\n${locations.filter((location) => !location.archived).map((location) => `${location.id}: ${location.name}`).join('\n')}`, item.locationId?.toString() ?? ''); if (locationText === null) return;
    action(() => api(`/items/${item.id}`, { method: 'PUT', body: JSON.stringify({
      name, aliases: aliasText.split(',').map((alias) => alias.trim()).filter(Boolean),
      lotSize: lotText.trim() ? Number(lotText) : null, locationId: locationText.trim() ? Number(locationText) : null,
    }) }));
  }

  function editBorrower(borrower: Borrower) {
    const name = prompt('שם', borrower.name); if (name === null) return;
    const username = prompt('שם משתמש', borrower.username); if (username === null) return;
    const contact = prompt('פרטי קשר', borrower.contact); if (contact === null) return;
    const type = prompt('סוג: individual / camp_organization / other', borrower.type); if (type === null) return;
    action(() => api(`/borrowers/${borrower.id}`, { method: 'PUT', body: JSON.stringify({ name, username, contact, type }) }));
  }

  return <div className="app">
    <header>
      <div><h1>מלאי מפ״ץ</h1><span className="offline">מקומי · עובד ללא אינטרנט</span></div>
      <div className="roles" aria-label="בחירת הרשאה">
        {(['guest', 'operator', 'admin'] as Role[]).map((role) => <button disabled={pending} key={role} className={session.role === role ? 'active' : ''} onClick={() => changeRole(role)}>{roleNames[role]}</button>)}
        {remaining != null && <span className={remaining <= 10 ? 'warning' : ''}>{remaining <= 10 ? 'ההרשאה תסתיים בעוד ' : 'זמן שנותר: '}{remaining} שנ׳</span>}
      </div>
    </header>
    <nav>{([
      ['inventory', 'מלאי'], ['checkout', 'ניפוק והשאלה'], ['returns', 'החזרות'], ['catalogs', 'ניהול'], ['ledger', 'יומן']
    ] as [Tab,string][]).map(([key, label]) => <button className={tab === key ? 'active' : ''} onClick={() => setTab(key)} key={key}>{label}</button>)}</nav>
    {message && <div className="notice" role="status" onClick={() => setMessage('')}>{message} ×</div>}
    <main>
      {tab === 'inventory' && <section>
        <div className="section-title"><h2>מצב מלאי</h2><input aria-label="חיפוש פריט" placeholder="חיפוש לפי שם, כינוי או קוד" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <table><thead><tr><th>קוד</th><th>פריט</th><th>סוג</th><th>זמין</th><th>פגום</th></tr></thead><tbody>
          {filteredItems.map((item) => <tr key={item.id}><td className="code">{item.code}</td><td>{item.name}</td><td>{item.kind === 'consumable' ? 'מתכלה' : 'מושאל'}</td><td>{item.available}</td><td>{item.damaged}</td></tr>)}
        </tbody></table>
      </section>}
      {tab === 'checkout' && <section className="grid two">
        <div className="flow-search"><label>סינון פריטים<input value={operationQuery} onChange={(event) => setOperationQuery(event.target.value)} placeholder="שם, כינוי או קוד"/></label><label>סינון שואלים<input value={borrowerQuery} onChange={(event) => setBorrowerQuery(event.target.value)} placeholder="שם או שם משתמש"/></label></div>
        <ActionCard title="ניפוק מתכלה" disabled={!canOperate || pending} onSubmit={(form) => action(() => api('/issue', { method: 'POST', body: JSON.stringify({ itemId: number(form, 'itemId'), quantity: number(form, 'quantity'), note: form.get('note') }) }))}>
          <Select name="itemId" label="פריט" options={operationItems.filter((i) => i.kind === 'consumable').map((i) => [i.id, `${i.code} — ${i.name} (${i.available})`])}/><Quantity /><Note />
        </ActionCard>
        <ActionCard title="השאלת ציוד" disabled={!canOperate || pending} onSubmit={(form) => action(() => api('/checkout', { method: 'POST', body: JSON.stringify({ itemId: number(form, 'itemId'), borrowerId: number(form, 'borrowerId'), quantity: number(form, 'quantity'), note: form.get('note') }) }))}>
          <Select name="itemId" label="פריט" options={operationItems.filter((i) => i.kind === 'non_consumable').map((i) => [i.id, `${i.code} — ${i.name} (${i.available})`])}/>
          <Select name="borrowerId" label="שואל" options={operationBorrowers.map((b) => [b.id, `${b.name} · ${b.username}`])}/><Quantity /><Note />
        </ActionCard>
        {!canOperate && <PermissionNote />}
      </section>}
      {tab === 'returns' && <section><h2>ציוד בחוץ</h2>
        <table><thead><tr><th>קוד</th><th>פריט</th><th>שואל</th><th>בחוץ</th><th>אבוד</th><th>פעולות</th></tr></thead><tbody>{loans.map((loan) => <tr key={loan.checkoutId}>
          <td className="code">{loan.code}</td><td>{loan.itemName}</td><td>{loan.borrowerName}</td><td>{loan.outstanding}</td><td>{loan.lost}</td>
          <td className="actions"><button disabled={pending || !canOperate || loan.outstanding < 1} onClick={() => returnLoan(loan)}>החזרה</button><button disabled={pending || !isAdmin || loan.outstanding < 1} onClick={() => changeLost(loan, true)}>סמן אבוד</button>
          <button disabled={pending || !isAdmin || loan.lost < 1} onClick={() => changeLost(loan, false)}>בטל אובדן</button></td>
        </tr>)}</tbody></table>
      </section>}
      {tab === 'catalogs' && <section className="grid three">
        <ActionCard title="שואל חדש" disabled={!canOperate || pending} onSubmit={(form) => action(() => api('/borrowers', { method: 'POST', body: JSON.stringify({ username: form.get('username'), name: form.get('name'), contact: form.get('contact'), type: form.get('type') }) }))}>
          <Field name="name" label="שם"/><Field name="username" label="שם משתמש" ltr/><Field name="contact" label="פרטי קשר"/><label>סוג<select name="type"><option value="individual">יחיד</option><option value="camp_organization">ארגון מחנה</option><option value="other">אחר</option></select></label>
        </ActionCard>
        <ActionCard title="פריט חדש" disabled={!isAdmin || pending} onSubmit={(form) => action(() => api('/items', { method: 'POST', body: JSON.stringify({ name: form.get('name'), kind: form.get('kind'), lotSize: form.get('lotSize') ? number(form, 'lotSize') : null, locationId: form.get('locationId') ? number(form, 'locationId') : null, aliases: String(form.get('aliases') ?? '').split(',').map((alias) => alias.trim()).filter(Boolean) }) }))}>
          <Field name="name" label="שם"/><label>סוג<select name="kind"><option value="consumable">מתכלה</option><option value="non_consumable">מושאל</option></select></label><Field name="lotSize" label="גודל מארז (רשות)" type="number" required={false}/><Field name="aliases" label="כינויים, מופרדים בפסיק" required={false}/><Select name="locationId" label="מיקום" required={false} emptyLabel="ללא מיקום" options={locations.filter((l) => !l.archived).map((l) => [l.id, l.name])}/>
        </ActionCard>
        <ActionCard title="הוספת מלאי" disabled={!isAdmin || pending} onSubmit={(form) => action(() => api('/stock/add', { method: 'POST', body: JSON.stringify({ itemId: number(form, 'itemId'), quantity: number(form, 'quantity'), note: form.get('note') }) }))}>
          <Select name="itemId" label="פריט" options={items.map((i) => [i.id, `${i.code} — ${i.name}`])}/><Quantity /><Note />
        </ActionCard>
        <ActionCard title="תיקון כמות מלאי" disabled={!isAdmin || pending} onSubmit={(form) => action(() => api('/stock/remove', { method: 'POST', body: JSON.stringify({ itemId: number(form, 'itemId'), quantity: number(form, 'quantity'), note: form.get('note') }) }))}>
          <Select name="itemId" label="פריט" options={items.map((i) => [i.id, `${i.code} — ${i.name} (${i.available})`])}/><Quantity/><Note label="סיבת התיקון (רשות)"/>
        </ActionCard>
        <ActionCard title="טיפול בפגום" disabled={!isAdmin || pending} onSubmit={(form) => action(() => api('/damage', { method: 'POST', body: JSON.stringify({ itemId: number(form, 'itemId'), quantity: number(form, 'quantity'), resolution: form.get('resolution'), note: form.get('note') }) }))}>
          <Select name="itemId" label="פריט" options={items.filter((i) => i.damaged > 0).map((i) => [i.id, `${i.code} — ${i.name} (${i.damaged})`])}/><Quantity/><label>פתרון<select name="resolution"><option value="repair">תוקן</option><option value="write_off">הוצאה מהמלאי</option></select></label><Note />
        </ActionCard>
        <ActionCard title="החלפת סיסמה" disabled={!isAdmin || pending} onSubmit={(form) => action(() => api('/password', { method: 'POST', body: JSON.stringify({ role: form.get('role'), password: form.get('password') }) }))}>
          <label>מצב<select name="role"><option value="operator">מפעיל</option><option value="admin">מנהל</option></select></label><Field name="password" label="סיסמה חדשה" type="password"/>
        </ActionCard>
        <ActionCard title="מיקום חדש" disabled={!isAdmin || pending} onSubmit={(form) => action(() => api('/locations', { method: 'POST', body: JSON.stringify({ code: form.get('code'), name: form.get('name') }) }))}>
          <Field name="name" label="שם בעברית"/><Field name="code" label="קוד" ltr/>
        </ActionCard>
        {!isAdmin && <PermissionNote />}
        <div className="catalog-table"><h2>קטלוג פריטים</h2><table><tbody>{catalogItems.map((item) => <tr key={item.id}><td className="code">{item.code}</td><td>{item.name}</td><td>{item.archived ? 'בארכיון' : 'פעיל'}</td><td className="actions"><button disabled={pending || !isAdmin} onClick={() => editItem(item)}>עריכה</button><button disabled={pending || !isAdmin} onClick={() => action(() => api(`/items/${item.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: !item.archived }) }))}>{item.archived ? 'שחזור' : 'ארכוב'}</button></td></tr>)}</tbody></table></div>
        <div className="catalog-table"><h2>קטלוג שואלים</h2><table><tbody>{catalogBorrowers.map((borrower) => <tr key={borrower.id}><td>{borrower.name}</td><td className="code">{borrower.username}</td><td>{borrower.archived ? 'בארכיון' : 'פעיל'}</td><td className="actions"><button disabled={pending || !isAdmin} onClick={() => {
          editBorrower(borrower);
        }}>עריכה</button><button disabled={pending || !isAdmin} onClick={() => action(() => api(`/borrowers/${borrower.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: !borrower.archived }) }))}>{borrower.archived ? 'שחזור' : 'ארכוב'}</button></td></tr>)}</tbody></table></div>
        <div className="catalog-table"><h2>מיקומים</h2><table><tbody>{locations.map((location) => <tr key={location.id}><td>{location.name}</td><td className="code">{location.code}</td><td>{location.archived ? 'בארכיון' : 'פעיל'}</td><td><button disabled={pending || !isAdmin} onClick={() => {
          const name = prompt('שם', location.name); const code = prompt('קוד', location.code); if (!name || !code) return;
          action(() => api(`/locations/${location.id}`, { method: 'PUT', body: JSON.stringify({ name, code, archived: location.archived }) }));
        }}>עריכה</button> <button disabled={pending || !isAdmin} onClick={() => action(() => api(`/locations/${location.id}`, { method: 'PUT', body: JSON.stringify({ ...location, archived: !location.archived }) }))}>{location.archived ? 'שחזור' : 'ארכוב'}</button></td></tr>)}</tbody></table></div>
      </section>}
      {tab === 'ledger' && <section><h2>יומן אירועים בלתי־ניתן לשינוי</h2><table><thead><tr><th>#</th><th>זמן</th><th>אירוע</th><th>פריט</th><th>שואל</th><th>כמות</th><th>הערה</th></tr></thead><tbody>{ledger.map((event) => <tr key={event.id}><td>{event.id}</td><td>{event.created_at}</td><td className="code">{event.kind}</td><td><span className="code">{event.itemCode}</span> {event.itemName}</td><td>{event.borrowerName ?? '—'}</td><td>{event.quantity}</td><td>{event.note || '—'}</td></tr>)}</tbody></table></section>}
    </main>
  </div>;
}

function ActionCard({ title, disabled, onSubmit, children }: { title: string; disabled: boolean; onSubmit: (form: FormData) => void; children: React.ReactNode }) {
  return <form className="card" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSubmit(new FormData(event.currentTarget)); }}><fieldset disabled={disabled}><legend>{title}</legend>{children}<button type="submit">בצע</button></fieldset></form>;
}
function Field({ name, label, type = 'text', ltr = false, required = true }: { name: string; label: string; type?: string; ltr?: boolean; required?: boolean }) { return <label>{label}<input required={required} name={name} type={type} dir={ltr ? 'ltr' : undefined}/></label>; }
function Quantity() { return <Field name="quantity" label="כמות" type="number"/>; }
function Note({ label = 'הערה (רשות)' }: { label?: string }) { return <Field name="note" label={label} required={false}/>; }
function Select({ name, label, options, required = true, emptyLabel = 'בחירה…' }: { name: string; label: string; options: [number,string][]; required?: boolean; emptyLabel?: string }) { return <label>{label}<select required={required} name={name}><option value="">{emptyLabel}</option>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>; }
function PermissionNote() { return <p className="permission">המסך גלוי לעיון. יש לעבור למצב מורשה כדי לבצע שינויים.</p>; }
