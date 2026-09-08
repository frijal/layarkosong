/**
 * Twikoo Loader for Layar Kosong
 * Versi: 1.9.0-turnstile-borrow-lazy-adaptive
 * Target: #response
 *
 * Prinsip:
 * - Twikoo dimuat secara lazy via IntersectionObserver saat mendekati #response
 *   (lihat OBSERVER_ROOT_MARGIN di bawah).
 * - Kalau Turnstile sudah ada di halaman (atau sedang dimuat), Twikoo "meminjam"
 *   window.turnstile alih-alih memuat ulang script api.js-nya sendiri.
 * - Duplicate Turnstile api.js dari Twikoo diblokir SEBELUM masuk DOM, supaya
 *   tidak ada request jaringan ganda ke Cloudflare.
 * - Timeout fallback saat "meminjam" Turnstile bersifat adaptif lewat Network
 *   Information API (navigator.connection) kalau browser mendukung; kalau
 *   tidak (Safari/Firefox saat ini belum mendukung), fallback ke basis tetap.
 * - Fallback otomatis ke eager-load kalau browser tidak mendukung
 *   IntersectionObserver (browser purba, atau environment aneh).
 */

interface TwikooInitOptions {
  envId: string;
  el: string;
  lang?: string;
}

interface TwikooApi {
  init(options: TwikooInitOptions): Promise<void> | void;
}

interface TurnstileApi {
  render?: (...args: unknown[]) => unknown;
  reset?: (...args: unknown[]) => unknown;
  remove?: (...args: unknown[]) => unknown;
  ready?: (callback: () => void) => void;
}

// Network Information API — masih "experimental" di spek, dan cuma didukung
// browser berbasis Chromium (Chrome, Edge, Android WebView, dst). Safari &
// Firefox tidak expose ini sama sekali, jadi kode di bawah WAJIB toleran
// terhadap connection yang undefined.
interface NetworkInformationLike {
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g';
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

type NavigatorWithConnection = Navigator & {
  connection?: NetworkInformationLike;
  mozConnection?: NetworkInformationLike;
  webkitConnection?: NetworkInformationLike;
};

interface LayarKosongTwikooState {
  loading: boolean;
  initializedContainers: WeakSet<Element>;
}

type LayarKosongWindow = Window & {
  twikoo?: TwikooApi;
  turnstile?: TurnstileApi;
  __LK_TWIKOO__?: LayarKosongTwikooState;
  __LK_TURNSTILE_SINGLETON_GUARD__?: boolean;
};

(function (): void {
  'use strict';

  const lkWindow = window as LayarKosongWindow;

  // --- Konfigurasi ---
  const TWIKOO_ENV_ID = 'https://kom.dalam.web.id';
  const TWIKOO_CONTAINER_ID = '#response';
  const TWIKOO_CDN = 'https://cdn.jsdelivr.net/npm/twikoo@latest/dist/twikoo.min.js';

  const OBSERVER_ROOT_MARGIN = '300px 0px'; // mulai load 300px sebelum #response kelihatan
  const SCRIPT_POLL_INTERVAL_MS = 100;
  const SCRIPT_POLL_MAX_ATTEMPTS = 80; // ~8 detik total sebelum menyerah

  // Basis & batas timeout borrow Turnstile — nilai final dihitung adaptif
  // lewat getTurnstileBorrowTimeoutMs() di bawah, bukan dipakai langsung.
  const TURNSTILE_BORROW_TIMEOUT_BASE_MS = 3000;
  const TURNSTILE_BORROW_TIMEOUT_MIN_MS = 2000;
  const TURNSTILE_BORROW_TIMEOUT_MAX_MS = 10000;

  const container = document.querySelector<HTMLElement>(TWIKOO_CONTAINER_ID);
  if (!container) return;

  lkWindow.__LK_TWIKOO__ = lkWindow.__LK_TWIKOO__ || {
    loading: false,
    initializedContainers: new WeakSet<Element>()
  };

  const twikooState = lkWindow.__LK_TWIKOO__;

  if (
    container.dataset.twikooState === 'loading' ||
    container.dataset.twikooState === 'ready' ||
    twikooState.initializedContainers.has(container)
  ) {
    return;
  }

  // Kalau Twikoo ternyata sudah pernah dirender ke container ini
  // (misal navigasi SPA-like / prerender), tandai selesai tanpa reload apa pun.
  if (
    container.querySelector('.tk-comments') ||
    container.querySelector('.tk-submit') ||
    container.querySelector('.tk-content')
  ) {
    container.dataset.twikooState = 'ready';
    twikooState.initializedContainers.add(container);
    return;
  }

  function isTurnstileScript(src: string): boolean {
    return /^https:\/\/challenges(?:\.fed)?\.cloudflare\.com\/turnstile\/v0(?:\/.*)?\/api\.js/i.test(src);
  }

  function getExistingTurnstileScript(): HTMLScriptElement | null {
    return Array.from(document.scripts).find((script) => isTurnstileScript(script.src)) || null;
  }

  function dispatchSyntheticLoad(node: Node): void {
    window.setTimeout(() => {
      try {
        node.dispatchEvent(new Event('load'));
      } catch {
        // Abaikan error event tiruan — worst case Twikoo retry sendiri.
      }
    }, 0);
  }

  /**
   * Hitung timeout borrow Turnstile berdasarkan kualitas koneksi.
   *
   * - Kalau Network Information API tidak tersedia (Safari, Firefox, atau
   *   Chromium versi lawas dengan flag mati), langsung pulang basis tetap.
   * - effectiveType ('slow-2g'..'4g') dipakai sebagai dasar kategori.
   * - rtt (round-trip time) dipakai buat menajamkan angka — berguna di
   *   koneksi seluler bersinyal lemah yang effectiveType-nya kadang
   *   optimis padahal latensi aslinya tinggi.
   * - saveData aktif dianggap sinyal "anggap koneksi terbatas", jadi kasih
   *   ruang napas ekstra biar Turnstile nggak keburu dianggap gagal.
   * - Hasil akhir selalu di-clamp ke [MIN, MAX] biar nggak pernah nembak
   *   angka absurd (misal 0ms atau 60 detik) walau input-nya aneh.
   */
  function getTurnstileBorrowTimeoutMs(): number {
    const nav = navigator as NavigatorWithConnection;
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;

    if (!connection) {
      return TURNSTILE_BORROW_TIMEOUT_BASE_MS;
    }

    const effectiveTypeTimeouts: Record<string, number> = {
      'slow-2g': 10000,
      '2g': 7000,
      '3g': 4500,
      '4g': 2500
    };

    let timeout = connection.effectiveType
      ? effectiveTypeTimeouts[connection.effectiveType] ?? TURNSTILE_BORROW_TIMEOUT_BASE_MS
      : TURNSTILE_BORROW_TIMEOUT_BASE_MS;

    if (typeof connection.rtt === 'number' && connection.rtt > 0) {
      timeout = Math.max(timeout, connection.rtt * 4);
    }

    if (connection.saveData) {
      timeout = Math.max(timeout, 6000);
    }

    return Math.min(Math.max(timeout, TURNSTILE_BORROW_TIMEOUT_MIN_MS), TURNSTILE_BORROW_TIMEOUT_MAX_MS);
  }

  function waitExistingTurnstileThenLoad(node: Node): void {
    if (lkWindow.turnstile) {
      dispatchSyntheticLoad(node);
      return;
    }

    const existingScript = getExistingTurnstileScript();

    if (!existingScript) {
      dispatchSyntheticLoad(node);
      return;
    }

    existingScript.addEventListener('load', () => dispatchSyntheticLoad(node), { once: true });
    existingScript.addEventListener('error', () => dispatchSyntheticLoad(node), { once: true });

    // Fallback: kalau script lama sudah selesai duluan tapi event load-nya
    // kepencet (race condition), jangan sampai Twikoo menggantung selamanya.
    // Durasinya adaptif — lebih longgar di koneksi lambat, lebih ketat di koneksi kencang.
    window.setTimeout(() => dispatchSyntheticLoad(node), getTurnstileBorrowTimeoutMs());
  }

  /**
   * Intinya: kalau Turnstile sudah ada / sedang dimuat, script Turnstile
   * kedua yang mau disuntik Twikoo TIDAK BOLEH masuk DOM sama sekali —
   * supaya tidak ada request jaringan kedua ke Cloudflare.
   *
   * Catatan desain: ini sengaja monkey-patch Node.prototype.appendChild dan
   * insertBefore, BUKAN MutationObserver. Alasannya: begitu <script src>
   * masuk DOM, browser langsung fetch — di titik itu sudah kelewat buat
   * dibatalkan. Intersepsi harus terjadi SEBELUM insert, dan appendChild/
   * insertBefore adalah satu-satunya titik yang bisa dicegat sebelum itu.
   * Guard ini scoped ketat ke URL Turnstile lewat isTurnstileScript(), jadi
   * risiko bentrok dengan script lain (analytics, dsb.) minim.
   */
  function installTurnstileSingletonGuard(): void {
    if (lkWindow.__LK_TURNSTILE_SINGLETON_GUARD__) return;
    lkWindow.__LK_TURNSTILE_SINGLETON_GUARD__ = true;

    const originalAppendChild = Node.prototype.appendChild;
    const originalInsertBefore = Node.prototype.insertBefore;

    function shouldBorrowExistingTurnstile(node: Node): boolean {
      if (!(node instanceof HTMLScriptElement)) return false;
      if (!isTurnstileScript(node.src)) return false;

      return Boolean(lkWindow.turnstile || getExistingTurnstileScript());
    }

    Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
      if (shouldBorrowExistingTurnstile(node)) {
        waitExistingTurnstileThenLoad(node);
        return node;
      }
      return originalAppendChild.call(this, node) as T;
    };

    Node.prototype.insertBefore = function <T extends Node>(
      this: Node,
      node: T,
      child: Node | null
    ): T {
      if (shouldBorrowExistingTurnstile(node)) {
        waitExistingTurnstileThenLoad(node);
        return node;
      }
      return originalInsertBefore.call(this, node, child) as T;
    };
  }

  function loadScript(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (lkWindow.twikoo) {
        resolve();
        return;
      }

      const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${url}"]`);

      if (existingScript) {
        let attempts = 0;

        const timer = window.setInterval(() => {
          attempts += 1;

          if (lkWindow.twikoo) {
            window.clearInterval(timer);
            resolve();
            return;
          }

          if (attempts >= SCRIPT_POLL_MAX_ATTEMPTS) {
            window.clearInterval(timer);
            reject(new Error('Twikoo script ada, tetapi window.twikoo tidak tersedia.'));
          }
        }, SCRIPT_POLL_INTERVAL_MS);

        return;
      }

      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.defer = true;

      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Gagal memuat Twikoo CDN: ${url}`));

      document.head.appendChild(script);
    });
  }

  async function initTwikoo(): Promise<void> {
    if (twikooState.loading) return;

    twikooState.loading = true;
    container.dataset.twikooState = 'loading';

    try {
      // Guard harus dipasang SEBELUM Twikoo dimuat, karena Twikoo bisa
      // menyuntik <script> Turnstile kapan saja setelah init() dipanggil.
      installTurnstileSingletonGuard();

      await loadScript(TWIKOO_CDN);

      if (!lkWindow.twikoo) {
        throw new Error('window.twikoo tidak tersedia setelah CDN dimuat.');
      }

      await lkWindow.twikoo.init({
        envId: TWIKOO_ENV_ID,
        el: TWIKOO_CONTAINER_ID,
        lang: 'id'
      });

      container.dataset.twikooState = 'ready';
      twikooState.initializedContainers.add(container);
    } catch (error) {
      container.dataset.twikooState = 'error';
      console.error('Gagal memuat Twikoo:', error);
    } finally {
      twikooState.loading = false;
    }
  }

  // --- Lazy load trigger ---
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            observer.disconnect();
            void initTwikoo();
          }
        });
      },
      { rootMargin: OBSERVER_ROOT_MARGIN }
    );

    observer.observe(container);
  } else {
    // Fallback untuk browser tanpa IntersectionObserver: langsung load saja.
    void initTwikoo();
  }
})();
