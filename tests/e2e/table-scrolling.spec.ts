import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function seedTables(page: Page) {
  const response = await page.request.post('/__e2e__/table-data');
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { borrower: { fullName: string; playaName: string } };
}

async function pinOnPage(page: Page, table: Locator) {
  await expect(table).toBeVisible();
  await expect.poll(() => table.locator('tbody tr').count()).toBeGreaterThan(20);
  await table.evaluate((element) => {
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 350);
  });
  const cell = table.locator('thead th').first();
  await expect
    .poll(async () => {
      const header = await cell.boundingBox();
      const nav = await page.locator('.app-nav').boundingBox();
      return Math.abs(header!.y - (nav!.y + nav!.height));
    })
    .toBeLessThan(2);
  await expect(cell).toBeVisible();
}

test('keeps ledger headers usable, contained, and pages at the reading start', async ({ page }) => {
  await seedTables(page);
  await page.goto('/ledger');
  const table = page.locator('.data-table');
  await expect(table.locator('tbody tr')).toHaveCount(50);
  const next = page.getByRole('button', { name: 'העמוד הבא' });
  await next.focus();
  await next.press('Enter');
  await expect(next).toBeFocused();
  await expect(table.locator('tbody tr')).toHaveCount(50);
  await expect(table.locator('tbody tr').first()).toBeInViewport();
  await expect(page.locator('.table-pagination')).toContainText('51–100');
  await pinOnPage(page, table);
  const sort = table.getByRole('button', { name: '#' });
  await sort.focus();
  await expect(sort).toBeInViewport();
  await sort.press('Enter');
  await expect(table.getByRole('columnheader', { name: '#' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expect(page.locator('.table-pagination')).toContainText('1–50');
  await expect(sort).toBeFocused();
  await expect(table.locator('tbody tr').first()).toBeInViewport();
  await table.evaluate((element) => {
    // Give the page content below the table so its end can cross the pin boundary.
    const spacer = document.createElement('div');
    spacer.style.height = '100vh';
    document.body.append(spacer);
    const nav = document.querySelector('.app-nav')!.getBoundingClientRect();
    window.scrollTo(0, element.getBoundingClientRect().bottom + window.scrollY - nav.bottom + 20);
  });
  await expect
    .poll(async () => {
      const header = await table.locator('thead th').first().boundingBox();
      const bounds = await table.boundingBox();
      return Math.abs(header!.y + header!.height - bounds!.y - bounds!.height);
    })
    .toBeLessThan(2);
  await page.screenshot({ path: '/tmp/mapatz-table-ledger.png' });
});

test('keeps pinned columns aligned during horizontal scrolling in narrow RTL layout', async ({
  page,
}) => {
  await seedTables(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ledger');
  const table = page.locator('.data-table');
  await pinOnPage(page, table);
  const shell = page.locator('.table-shell');
  await shell.evaluate((element) => {
    element.scrollLeft = -250;
  });
  await expect.poll(() => shell.evaluate((element) => element.scrollLeft)).toBeLessThan(-100);
  for (const index of [0, 1, 3]) {
    const header = await table.locator('thead th').nth(index).boundingBox();
    const cell = await table.locator('tbody tr').first().locator('td').nth(index).boundingBox();
    expect(Math.abs(header!.x - cell!.x)).toBeLessThan(2);
    expect(Math.abs(header!.width - cell!.width)).toBeLessThan(2);
  }
  await page.screenshot({ path: '/tmp/mapatz-table-rtl.png' });
});

for (const variant of [
  'inventory',
  'directory',
  'summary',
  'consumables',
  'locations',
  'radios',
] as const) {
  test(`pins specialized ${variant} headers to the page`, async ({ page }) => {
    await seedTables(page);
    const path =
      variant === 'directory' || variant === 'consumables'
        ? '/desk'
        : variant === 'summary'
          ? '/summary'
          : variant === 'radios'
            ? '/radios'
            : '/management';
    await page.goto(path);
    if (variant === 'consumables')
      await page.getByRole('button', { name: 'ציוד מתכלה', exact: true }).click();
    if (variant === 'locations')
      await page.getByRole('button', { name: 'מיקומים', exact: true }).click();
    const selector =
      variant === 'directory'
        ? '.borrower-directory-table'
        : variant === 'summary'
          ? '.period-summary-table'
          : variant === 'consumables'
            ? '.consumables-table'
            : variant === 'locations'
              ? '#locations-view-panel .data-table'
              : '.data-table:visible';
    await pinOnPage(page, page.locator(selector));
  });
}

for (const width of [1280, 390]) {
  test(`pins holdings and lost headers within the borrower dialog at ${width}px`, async ({
    page,
  }) => {
    const { borrower } = await seedTables(page);
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/desk');
    await page.getByRole('searchbox', { name: 'חיפוש שואל' }).fill(borrower.playaName);
    await page.getByRole('button', { name: `פתיחת כרטיס שואל — ${borrower.fullName}` }).click();
    const card = page.getByRole('dialog', { name: /כרטיס שואל/ });
    await expect(card).toBeVisible();
    const backgroundScroll = await page.evaluate(() => window.scrollY);
    const body = card.locator('.dialog-shell-body');
    const held = card.locator('.holdings-section table');
    await expect(held.locator('tbody tr')).toHaveCount(36);
    for (const table of [held, card.locator('.lost-equipment-section table')]) {
      if (table !== held) await card.locator('.lost-equipment-section summary').click();
      await table.evaluate((element) => {
        const owner = element.closest('.dialog-shell-body')!;
        owner.scrollTop +=
          element.getBoundingClientRect().top - owner.getBoundingClientRect().top + 250;
      });
      await expect
        .poll(async () => {
          const header = await table.locator('thead th').first().boundingBox();
          const bounds = await body.boundingBox();
          return Math.abs(header!.y - bounds!.y);
        })
        .toBeLessThan(2);
      await expect(table.locator('thead th').first()).toHaveCSS('position', 'sticky');
      const header = await table.locator('thead th').first().boundingBox();
      const footer = await card.locator('.dialog-shell-actions').boundingBox();
      expect(header!.y + header!.height).toBeLessThan(footer!.y);
      expect(await page.evaluate(() => window.scrollY)).toBe(backgroundScroll);
    }
    await page.screenshot({ path: `/tmp/mapatz-table-dialog-${width}.png` });
  });
}

for (const variant of ['directory', 'consumables'] as const) {
  test(`preserves labeled mobile ${variant} cards without floating hidden headers`, async ({
    page,
  }) => {
    await seedTables(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/desk');
    if (variant === 'consumables')
      await page.getByRole('button', { name: 'ציוד מתכלה', exact: true }).click();
    const table = page.locator(
      variant === 'directory' ? '.borrower-directory-table' : '.consumables-table',
    );
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await table.evaluate((element) =>
      window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 350),
    );
    await expect
      .poll(() =>
        table.evaluate((element) => element.style.getPropertyValue('--table-header-animation')),
      )
      .toBe('none');
    const header = await table.locator('thead').boundingBox();
    expect(header!.height).toBeLessThanOrEqual(1);
    await expect(table.locator('thead')).toHaveCSS('position', 'absolute');
    if (variant === 'directory') {
      expect(
        await table
          .locator('tbody td')
          .first()
          .evaluate((element) => getComputedStyle(element, '::before').content),
      ).toContain('שם');
    } else {
      await expect(table.locator('tbody th').first()).toHaveAttribute('scope', 'row');
      expect(
        await table
          .locator('.consumables-available')
          .first()
          .evaluate((element) => getComputedStyle(element, '::before').content),
      ).toContain('זמין');
    }
  });
}

test('updates a pinned header when preceding content moves without a scroll event', async ({
  page,
}) => {
  await seedTables(page);
  await page.goto('/ledger');
  const table = page.locator('.data-table');
  await pinOnPage(page, table);
  // Disable automatic scroll anchoring to isolate the layout observer from scroll events.
  await page.evaluate(() => {
    document.documentElement.style.overflowAnchor = 'none';
  });
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await table.evaluate((element) => {
    const preceding = document.createElement('div');
    preceding.style.height = '100px';
    element.parentElement!.before(preceding);
  });
  await expect
    .poll(async () => {
      const header = await table.locator('thead th').first().boundingBox();
      const nav = await page.locator('.app-nav').boundingBox();
      return Math.abs(header!.y - nav!.y - nav!.height);
    })
    .toBeLessThan(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
});

test('keeps headers pinned through native scroll timelines without per-scroll style updates', async ({
  page,
}) => {
  await seedTables(page);
  await page.goto('/ledger');
  const table = page.locator('.data-table');
  await pinOnPage(page, table);
  const header = table.locator('thead th').first();
  await expect(header).toHaveCSS('animation-timeline', 'scroll(root)');
  await table.evaluate(async (element) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    element.setAttribute('data-scroll-style-writes', '0');
    let writes = 0;
    const observer = new MutationObserver((records) => {
      writes += records.length;
      element.setAttribute('data-scroll-style-writes', String(writes));
    });
    observer.observe(element, { attributes: true, attributeFilter: ['style'] });
  });
  const layoutStyles = await table.getAttribute('style');
  for (const delta of [80, 120, -65, 200, -150]) {
    const previousScroll = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, delta);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(previousScroll + delta);
    await expect
      .poll(async () => {
        const rect = await header.boundingBox();
        const nav = await page.locator('.app-nav').boundingBox();
        return Math.abs(rect!.y - nav!.y - nav!.height);
      })
      .toBeLessThan(2);
    expect(await table.getAttribute('style')).toBe(layoutStyles);
    await expect(table).toHaveAttribute('data-scroll-style-writes', '0');
  }
});

test('uses the actual scroll owner when a dialog scrolls as a whole', async ({ page }) => {
  const { borrower } = await seedTables(page);
  await page.goto('/desk');
  await page.getByRole('searchbox', { name: 'חיפוש שואל' }).fill(borrower.playaName);
  await page.getByRole('button', { name: `פתיחת כרטיס שואל — ${borrower.fullName}` }).click();
  const card = page.getByRole('dialog', { name: /כרטיס שואל/ });
  // Exercise the standard Dialog layout, which scrolls the shell instead of its body.
  await card.evaluate((element) => element.classList.remove('dialog-workspace'));
  const table = card.locator('.holdings-section table');
  await expect(table.locator('tbody tr')).toHaveCount(36);
  await expect(card.locator('.dialog-shell-body')).toHaveCSS('overflow-y', 'visible');
  await table.evaluate((element) => {
    const owner = element.closest('.dialog')!;
    owner.scrollTop +=
      element.getBoundingClientRect().top - owner.getBoundingClientRect().top + 250;
  });
  await expect
    .poll(async () => {
      const header = await table.locator('thead th').first().boundingBox();
      const pinTop = await card.evaluate(
        (element) =>
          element.getBoundingClientRect().top +
          element.clientTop +
          Number.parseFloat(getComputedStyle(element).paddingTop),
      );
      return Math.abs(header!.y - pinTop);
    })
    .toBeLessThan(2);
  await expect(table.locator('thead th').first()).toHaveCSS('position', 'sticky');
});
