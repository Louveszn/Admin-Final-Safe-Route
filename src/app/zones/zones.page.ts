import { Component, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule, AlertController } from '@ionic/angular';
import { SidebarComponent } from '../sidebar/sidebar.component';
import * as L from 'leaflet';

import {
  Firestore,
  collection, doc, addDoc, updateDoc, getDoc,
  collectionData, where, query as fsQuery,
  serverTimestamp, Timestamp,
} from '@angular/fire/firestore';

import { getAuth, onAuthStateChanged, User } from 'firebase/auth';
import { Subscription } from 'rxjs';

/* ---------- Types ---------- */
type ReportStatus = 'pending' | 'verified' | 'resolved';
interface ReportDoc {
  id?: string;
  category?: string;
  subCategory?: string; // kept optional for backward compat
  description?: string;
  barangay?: string;
  datetime?: any;
  lat?: number | string;
  lng?: number | string;
  status?: ReportStatus;
  userId?: string;
  createdBy?: string;
  color?: string;
  severity?: number;
  createdAt?: any;
}

type PointEx = {
  id?: string;
  lat: number;
  lng: number;
  color: string;
  category?: string;
  subCategory?: string;
  when?: Date;
  barangay?: string;
  description?: string;
  status?: ReportStatus;
  severity?: number;
  datetime?: Date | string | null;
};

type ClusterEx = { center: { lat: number; lng: number }; points: PointEx[] };

@Component({
  selector: 'app-zones',
  templateUrl: './zones.page.html',
  styleUrls: ['./zones.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, SidebarComponent],
})
export class ZonesPage implements AfterViewInit, OnDestroy {
  /* Map & layers */
  private map!: L.Map;

  private outlineLayer = L.layerGroup();
  private clusterLayer = L.layerGroup();
  private reportHaloLayer = L.layerGroup();
  private reportDotLayer = L.layerGroup();
  private freshLayer = L.layerGroup();

  private resizeHandler = () => this.map?.invalidateSize();
  private clickHandler?: (e: L.LeafletMouseEvent) => void;

  private canvasRenderer!: L.Canvas;
  private sharedPopup!: L.Popup;

  private _renderSeq = 0;
  private _rafId: number | null = null;

  /* UI state */
  tapEnabled = false;
  reportOpen = false;
  lastLatLng: { lat: number; lng: number } | null = null;

  selected = new Set<string>();
  private readonly SHOW_ALL_WHEN_NONE_SELECTED = true;

  barangay = '';
  coordText = '';
  nowPreview = '';

  // form (no subCategory)
  form = { category: '', customCategory: '', description: '' };

  // Character limits
  readonly DESCRIPTION_MAX = 100;

  catPickerOpen = false;
  catPickerEvent: any = null;

  // Hover state for category examples
  categoryHoverOpen = false;
  categoryHoverEvent: any = null;
  hoveredCategory: { key: string; name: string; samples: string[] } | null = null;

  // Category catalog with hover samples
  CATEGORY_LIST = [
    { key: 'theft',         name: 'Theft',          samples: ['Pickpocketing', 'Shoplifting', 'Burglary', 'Vehicle Theft'] },
    { key: 'assault',       name: 'Assault',        samples: ['Physical Attack', 'Verbal Abuse', 'Harassment', 'Battery'] },
    { key: 'flood',         name: 'Flood',          samples: ['Flash Flood', 'Street Flooding', 'River Overflow', 'Heavy Rain'] },
    { key: 'caraccident',   name: 'Car Accident',   samples: ['Collision', 'Hit-and-Run', 'Vehicle Crash', 'Motorcycle Accident'] },
    { key: 'blockedlane',   name: 'Blocked Lane',   samples: ['Road Construction', 'Parked Vehicle', 'Debris', 'Traffic Jam'] },
    { key: 'kidnapping',    name: 'Kidnapping',     samples: ['Child Abduction', 'Missing Person', 'Forced Detention'] },
    { key: 'fire',          name: 'Fire',           samples: ['House Fire', 'Vehicle Fire', 'Wildfire', 'Electrical Fire'] },
    { key: 'animalattack',  name: 'Animal Attack',  samples: ['Dog Bite', 'Stray Animals', 'Wildlife Encounter', 'Snake'] },
    { key: 'robbery',       name: 'Robbery',        samples: ['Armed Robbery', 'Mugging', 'Home Invasion', 'Store Holdup'] },
  ];

  private reportsSub?: Subscription;
  private authUnsub?: () => void;
  private allReports: ReportDoc[] = [];

  private uid: string | null = null;
  private email: string | null = null;

  // Admin scope cache
  private adminRestrictCached: boolean | null = null;
  private allowedBarangays: string[] = [];
  private lastAdminKey: string | null = null;

  /* Colors */
  private catColor: Record<string, string> = {
    Theft: '#0041c2',
    Assault: '#ffa500',
    Flood: '#87ceeb',
    'Car Accident': '#ee4b2b',
    'Blocked Lane': '#e5e500',
    Kidnapping: '#6a329f',
    Fire: '#dc4d01',
    'Animal Attack': '#964b00',
    Robbery: '#06402b'
  };

  private dangerColor(score01: number): string {
    if (score01 < 0.35) return '#ffff00';
    if (score01 < 0.50) return '#ffa500';
    return '#ff0000';
  }

  /* Radii */
  private readonly HALO_RADIUS_M = 100;
  private readonly CLUSTER_RADIUS_M = 235;

  /* ---------- Scoring controls ---------- */
  private readonly RESOLVED_SEVERITY_MULT = 0.37;
  private readonly SCORE_WEIGHTS = { count: 0.20, compact: 0.24, severity: 0.38, recency: 0.18 };
  private readonly VISIBLE_FLOOR = 0.0;

  /* Barangay polygons (unchanged) */
  private POLYGONS: Record<string, [number, number][]> = {
    'Carig Sur': [
      [17.66301947673273, 121.73118056780248],
      [17.650777604730315, 121.7363049725038],
      [17.648095285699988, 121.74142937724469],
      [17.646994835565994, 121.7474198785615],
      [17.647613839593724, 121.75781303747257],
      [17.64630705081782, 121.76113307434694],
      [17.65634844734729, 121.76726792509308],
      [17.662056662792782, 121.7737636494125],
      [17.671068730302334, 121.75253549600292],
    ],
    'Carig Norte': [
      [17.671624175550466, 121.75279319559237],
      [17.672237528276824, 121.74996078301383],
      [17.67332111298083, 121.74805105029046],
      [17.671787736482027, 121.74712837043535],
      [17.681661811641, 121.73468332259671],
      [17.68650365860692, 121.741034546962],
      [17.685115906896026, 121.74414498449481],
      [17.685313, 121.757698],
      [17.683964, 121.765294],
      [17.685068, 121.772676],
      [17.684542, 121.779993],
      [17.664244, 121.770551],
    ],
    'Linao East': [
      [17.653743857017393, 121.73299772466706],
      [17.649092512763534, 121.71937432688945],
      [17.645146066156926, 121.72080126212546],
      [17.6462195899607, 121.7286011259559],
      [17.646833029272294, 121.7316266578886],
      [17.65229853844148, 121.73136629557996],
      [17.65253368248669, 121.73312582478904],
    ],
    'Linao West': [
      [17.648167710601882, 121.7070070603481],
      [17.66948759569577, 121.71155406737171],
      [17.653029482477105, 121.72105254734704],
      [17.64898010205808, 121.71935316957513],
      [17.648167710601882, 121.7070070603481],
    ],
    'Linao Norte': [
      [17.653767069733973, 121.73300244317701],
      [17.677981484640267, 121.72552487289595],
      [17.66942999982645, 121.7115730269331],
      [17.653057626072606, 121.7210653878961],
    ],
  };

  constructor(private alertCtrl: AlertController, private fs: Firestore) {}

  /* Lifecycle */
  ngAfterViewInit(): void {
    // AUTH
    const auth = getAuth();
    this.authUnsub = onAuthStateChanged(auth, (user: User | null) => {
      this.uid = user?.uid || null;
      this.email = user?.email ? user.email.toLowerCase() : null;
      this.preloadAdminScope();
    });

    // MAP
    this.map = L.map('map', { zoomControl: true, attributionControl: true })
      .setView([17.6333, 121.7220], 14);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(this.map);

    this.canvasRenderer = L.canvas({ padding: 0.25 });
    this.sharedPopup = L.popup({ maxWidth: 320, autoPan: true });

    this.outlineLayer.addTo(this.map);
    this.clusterLayer.addTo(this.map);
    this.reportHaloLayer.addTo(this.map);
    this.reportDotLayer.addTo(this.map);
    this.freshLayer.addTo(this.map);

    this.clickHandler = (e: L.LeafletMouseEvent) => {
      if (!this.tapEnabled) return;

      const { lat, lng } = e.latlng;
      const coords = this.POLYGONS[this.barangay];
      if (!coords || coords.length < 3) return;

      const inside = this.isPointInsidePolygonLL([lat, lng], coords);
      if (!inside) {
        this.alert('Outside Barangay', 'You cannot report incidents outside your barangay boundary.');
        this.reportOpen = false;
        return;
      }

      this.lastLatLng = { lat, lng };
      this.coordText = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      this.openReport();
    };
    this.map.on('click', this.clickHandler);

    this.barangay = this.normalizeBarangay(localStorage.getItem('barangay') || 'Carig Sur');
    this.fitBarangay();

    this.subscribeReports();

    window.addEventListener('resize', this.resizeHandler, { passive: true });
    this.map.whenReady(() => setTimeout(() => this.map.invalidateSize(), 80));
  }

  ngOnDestroy(): void {
    this.reportsSub?.unsubscribe();
    if (this.authUnsub) this.authUnsub();
    if (this.map && this.clickHandler) this.map.off('click', this.clickHandler);
    [this.reportHaloLayer, this.reportDotLayer, this.clusterLayer, this.outlineLayer, this.freshLayer].forEach(l => l.clearLayers());
    this.map?.remove();
    // @ts-ignore
    this.map = undefined;
    window.removeEventListener('resize', this.resizeHandler as any);
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
  }

  /* Template hooks */
  toggleTap() {
    this.tapEnabled = !this.tapEnabled;
    if (!this.tapEnabled) this.closeReport();
    if (this.tapEnabled) this.map.closePopup();
    this.renderReports();
  }
  isSelected(cat: string) { return this.selected.has(cat); }
  toggleCategory(cat: string) {
    if (this.selected.has(cat)) this.selected.delete(cat); else this.selected.add(cat);
    this.renderReports();
  }

  // Category picker handlers
  openCategoryPicker(ev: any) {
    this.catPickerEvent = ev;
    this.catPickerOpen = true;
  }
  
  selectCategory(c: { name: string }) {
    this.form.category = c.name;
    this.catPickerOpen = false;
  }

  openReport() {
    this.nowPreview = new Date().toLocaleString();
    this.form = { category: '', customCategory: '', description: '' };
    this.reportOpen = true;
  }
  closeReport() { this.reportOpen = false; }

  /* Current auth */
  private getCurrentAuth(): { uid: string | null; email: string | null } {
    const auth = getAuth();
    const u = auth.currentUser;
    return {
      uid: u?.uid || this.uid,
      email: (u?.email || this.email || '').toLowerCase() || null,
    };
  }

  /* ---------- Admin scope ---------- */
  private preloadAdminScope() {
    const { uid } = this.getCurrentAuth();
    const key = uid || 'anon';
    if (this.lastAdminKey === key && this.adminRestrictCached !== null) return;

    this.lastAdminKey = key;

    if (!uid) {
      this.adminRestrictCached = false;
      this.allowedBarangays = [];
      this.renderReports();
      return;
    }

    const provisional = this.normalizeBarangay(localStorage.getItem('barangay') || this.barangay);
    this.allowedBarangays = provisional ? [provisional] : [];
    this.adminRestrictCached = true;
    this.renderReports();

    this.loadAllowedBarangays(uid).then(list => {
      const normList = Array.from(new Set(list.map(this.normalizeBarangay)));
      this.allowedBarangays = normList.length ? normList : (provisional ? [provisional] : []);
      this.adminRestrictCached = true;
      this.renderReports();
    }).catch(() => {
      this.allowedBarangays = provisional ? [provisional] : [];
      this.adminRestrictCached = true;
      this.renderReports();
    });
  }

  private async loadAllowedBarangays(uid: string): Promise<string[]> {
    const snap = await getDoc(doc(this.fs, 'admins', uid));
    if (!snap.exists()) return [];
    const data: any = snap.data() || {};
    const out: string[] = [];
    const pushMaybe = (v: any) => {
      const s = this.normalizeBarangay(String(v || ''));
      if (s) out.push(s);
    };
    if (typeof data.barangay === 'string') pushMaybe(data.barangay);
    if (Array.isArray(data.barangays)) data.barangays.forEach(pushMaybe);
    if (Array.isArray(data.allowedBarangays)) data.allowedBarangays.forEach(pushMaybe);
    if (Array.isArray(data.allowed)) data.allowed.forEach(pushMaybe);
    if (data.barangay_ref) {
      const r = await this.readBarangayRefName(data.barangay_ref);
      if (r) pushMaybe(r);
    }
    if (Array.isArray(data.barangay_refs)) {
      for (const ref of data.barangay_refs) {
        const r = await this.readBarangayRefName(ref);
        if (r) pushMaybe(r);
      }
    }
    return out;
  }

  private async readBarangayRefName(refOrPath: any): Promise<string | null> {
    try {
      let ref: any;
      if (refOrPath && typeof refOrPath === 'object' && typeof refOrPath.id === 'string') {
        ref = refOrPath;
      } else if (typeof refOrPath === 'string') {
        ref = doc(this.fs, refOrPath);
      } else if (refOrPath && typeof refOrPath.path === 'string') {
        ref = doc(this.fs, refOrPath.path);
      } else {
        return null;
      }
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;
      const d: any = snap.data() || {};
      const byName = String(d?.name ?? d?.title ?? '');
      if (byName) return byName;
      return snap.id?.replace(/-/g, ' ') || null;
    } catch {
      return null;
    }
  }

  async saveReport() {
    const { uid, email } = this.getCurrentAuth();
    if (!uid || !email) return this.alert('Not signed in', 'Please sign in to submit a report.');
    if (!this.lastLatLng) return this.alert('Missing location', 'Tap the map to choose a spot.');

    const mainCat = this.form.category === 'Others'
      ? (this.form.customCategory || '').trim()
      : this.form.category;
    if (!mainCat) return this.alert('Missing info', 'Choose a category.');

    const description = (this.form.description || '').trim();

    if (description.length > this.DESCRIPTION_MAX)
      return this.alert('Too long', `Description must be ${this.DESCRIPTION_MAX} characters or fewer.`);

    const subCat = ''; // not used

    const { lat, lng } = this.lastLatLng;
    const color = this.catColor[mainCat] || this.catColor['Others'] || '#6b7280';
    const brgy = this.normalizeBarangay(this.barangay);
    const status: ReportStatus = 'verified';

    try {
      // Optional cluster capacity check (unchanged)
      if (this.allReports && this.allReports.length > 0) {
        const simulatedReports = [...this.allReports];
        const tempPoint = {
          id: 'temp',
          lat,
          lng,
          color,
          category: mainCat,
          subCategory: subCat || undefined,
          when: new Date(),
          barangay: brgy,
          description: this.form.description,
          status,
          severity: this.incidentScore(mainCat),
          datetime: new Date(),
        };
        simulatedReports.push(tempPoint as any);
        const clusters = this.kmeansByProximity(
          simulatedReports.map(r => ({
            id: (r as any).id,
            lat: Number((r as any).lat),
            lng: Number((r as any).lng),
            color: (r as any).color || '#999',
            category: (r as any).category,
            subCategory: (r as any).subCategory,
            when: this.toDate((r as any).datetime),
            barangay: (r as any).barangay,
            description: (r as any).description,
            status: (r as any).status,
            severity: (r as any).severity,
            datetime: (r as any).datetime,
          })),
          this.CLUSTER_RADIUS_M,
          2
        );
        const clusterHere = clusters.find(c =>
          this.haversine(lat, lng, c.center.lat, c.center.lng) <= this.CLUSTER_RADIUS_M
        );
        if (clusterHere && clusterHere.points.length >= 8) {
          await this.alert('Cluster Limit Reached',
            'Maximum of 8 incidents are allowed within this cluster. This report was not saved.');
          this.renderReports();
          return;
        }
      }

      const docRef = await addDoc(collection(this.fs, 'reports'), {
        category: mainCat,
        description: (this.form.description || '').trim(),
        barangay: brgy,
        datetime: serverTimestamp(),
        status,
        lat,
        lng,
        userId: uid,
        createdBy: email,
        color,
        createdAt: serverTimestamp(),
        severity: this.incidentScore(mainCat),
      });

      const newReport: ReportDoc = {
        id: docRef.id,
        category: mainCat,
        description: (this.form.description || '').trim(),
        barangay: brgy,
        datetime: new Date(),
        lat,
        lng,
        status,
        color,
        severity: this.incidentScore(mainCat),
      };

      this.allReports.push(newReport);
      this.renderReports();

      await this.alert('Saved', 'Report saved and verified.');
      this.reportOpen = false;
      this.tapEnabled = false;
    } catch (e: any) {
      console.error('Save report failed:', e);
      this.alert('Save failed', e.message || 'Could not save the report.');
    }
  }

  private clearMapLayers() {
    this.reportDotLayer.clearLayers();
    this.reportHaloLayer.clearLayers();
    this.clusterLayer.clearLayers();
  }

  /* VERIFIED + RESOLVED reports on map */
  private subscribeReports() {
    const q = fsQuery(collection(this.fs, 'reports'), where('status', 'in', ['verified', 'resolved']));
    this.reportsSub = collectionData(q, { idField: 'id' }).subscribe({
      next: (rows: any) => {
        this.allReports = rows as ReportDoc[];
        this.renderReports();
      },
      error: (e) => console.error('reports subscribe error', e),
    });
  }

  /* Rendering (unchanged) */
  private renderReports() {
    const seq = ++this._renderSeq;
    if (this._rafId != null) { cancelAnimationFrame(this._rafId); this._rafId = null; }

    this.reportDotLayer.clearLayers();
    this.reportHaloLayer.clearLayers();
    this.clusterLayer.clearLayers();

    const hasFilter = this.selected.size > 0;
    const base = this.allReports.slice();

    let filtered = hasFilter
      ? base.filter(r => r.category && this.selected.has(r.category!))
      : base;

    if (this.adminRestrictCached) {
      const allowSet = new Set(this.allowedBarangays.map(this.normalizeBarangay));
      filtered = filtered.filter(r => {
        const brgyName = this.normalizeBarangay(r.barangay || '');
        const byName = allowSet.has(brgyName);
        const c = this.coordsOf(r);
        const byGeom = c ? this.isInsideAnyAllowed(c.lat, c.lng, allowSet) : false;
        return byName || byGeom;
      });
    }

    const points: PointEx[] = [];
    for (const r of filtered) {
      const c = this.coordsOf(r);
      if (!c) continue;
      const color = this.catColor[r.category || 'Others'] || '#6b7280';
      const when = this.toDate(r.datetime) || this.toDate((r as any).createdAt);
      points.push({
        id: r.id, lat: c.lat, lng: c.lng,
        category: r.category, subCategory: r.subCategory,
        color, when, datetime: when || null,
        severity: this.incidentScore(r.category || ''),
        barangay: r.barangay,
        description: r.description, status: r.status,
      });
    }

    let clusters: ClusterEx[] = [];
    if (points.length) clusters = this.kmeansByProximity(points, this.CLUSTER_RADIUS_M, 2);
    if (seq !== this._renderSeq) return;

    this.drawClusters(clusters, seq);

    const CHUNK = 400;
    let i = 0;
    const len = points.length;
    const drawChunk = () => {
      if (seq !== this._renderSeq) return;
      const end = Math.min(i + CHUNK, len);
      for (; i < end; i++) {
        const p = points[i];

        const halo = L.circle([p.lat, p.lng], {
          radius: this.HALO_RADIUS_M,
          color: p.status === 'resolved' ? '#88e788' : p.color,
          fillColor: p.status === 'resolved' ? '#88e788' : p.color,
          fillOpacity: 0.12,
          weight: 3,
          interactive: true,
          renderer: this.canvasRenderer,
        }).addTo(this.reportHaloLayer);

        halo.on('click', () => {
          const html = this.buildReportPopup(p);
          this.sharedPopup.setLatLng(halo.getLatLng()).setContent(html);
          this.map.openPopup(this.sharedPopup);
        });

        const dot = L.circleMarker([p.lat, p.lng], {
          radius: 12,
          weight: 3,
          color: '#ffffff',
          fillColor: p.status === 'resolved' ? '#88e788' : p.color,
          fillOpacity: 1,
          interactive: true,
          renderer: this.canvasRenderer,
        }).addTo(this.reportDotLayer);

        dot.on('click', () => {
          const html = this.buildReportPopup(p);
          this.sharedPopup.setLatLng(dot.getLatLng()).setContent(html);
          this.map.openPopup(this.sharedPopup);
        });
      }

      if (i < len) {
        this._rafId = requestAnimationFrame(drawChunk);
      } else {
        this._rafId = null;
      }
    };
    drawChunk();
  }

  /* ---------- Proximity-first clustering, scoring & utils (unchanged) ---------- */
  private kmeansByProximity(points: PointEx[], radiusM = 235, minPts = 2): ClusterEx[] {
    const n = points.length;
    if (n < minPts) return [];
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const unite = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dist = this.haversine(points[i].lat, points[i].lng, points[j].lat, points[j].lng);
        if (dist <= radiusM) unite(i, j);
      }
    }
    const bins = new Map<number, PointEx[]>();
    for (let i = 0; i < n; i++) { const r = find(i); if (!bins.has(r)) bins.set(r, []); bins.get(r)!.push(points[i]); }
    const clusters: ClusterEx[] = [];
    let fullCluster: ClusterEx | null = null;
    for (const pts of bins.values()) {
      if (pts.length < minPts) continue;
      if (pts.length > 8) {
        this.alert('Cluster Limit Reached', 'Maximum of 8 incidents are allowed in a single cluster. Extra reports will not be included.');
        pts.length = 8;
      }
      const { toXY, toLL } = this.llToXYFactory(pts);
      let cx = 0, cy = 0;
      for (const p of pts) { const v = toXY(p.lat, p.lng); cx += v.x; cy += v.y; }
      cx /= pts.length; cy /= pts.length;
      const center = toLL(cx, cy);
      const cluster = { center, points: pts };
      clusters.push(cluster);
      if (pts.length === 8 && !fullCluster) fullCluster = cluster;
    }
    if (fullCluster && this.map && this.sharedPopup) {
      const avgPreScore = fullCluster.points.reduce((s, p) => s + this.preClusterDangerScore(p), 0) / fullCluster.points.length;
      const wCount = Math.min(fullCluster.points.length, 8);
      const avgD = fullCluster.points.reduce((s, p) => s + this.haversine(p.lat, p.lng, fullCluster.center.lat, fullCluster.center.lng), 0) / fullCluster.points.length;
      const sCount = this.normCount(wCount);
      const sCompact = this.normCompact(avgD);
      const W = this.SCORE_WEIGHTS;
      const score = Math.min(avgPreScore + (W.count * sCount) + (W.compact * sCompact), 1);
      const riskLabel = score < 0.35 ? 'Low' : score < 0.50 ? 'Medium' : 'High';
      const html = `
        <div style="font: 16px/1.3 system-ui;">
          <div style="font-weight:700;margin-bottom:6px;">Cluster Summary</div>
          <div><b>Danger Level:</b> ${riskLabel}</div>
          <div><b>Final Danger Score:</b> ${score.toFixed(3)}</div>
          <div><b>Total Incidents:</b> ${fullCluster.points.length}</div>
          <div><b>Avg. Preliminary Score:</b> ${avgPreScore.toFixed(3)}</div>
          <div><b>Avg. Spread:</b> ${avgD.toFixed(0)} m</div>
        </div>
      `;
      this.sharedPopup.setLatLng([fullCluster.center.lat, fullCluster.center.lng]).setContent(html);
      this.map.openPopup(this.sharedPopup);
    }
    return clusters;
  }

  private incidentScore(category: string): number {
    switch ((category || '').toLowerCase()) {
      case 'assault': return 5.25;
      case 'theft': return 3.40;
      case 'fire': return 3.40;
      case 'car accident': return 5.80;
      case 'blocked lane': return 2.20;
      case 'flood': return 6.60;
      case 'kidnapping': return 2.00;
      case 'animal attack': return 3.00;
      case 'robbery': return 1.80;
      default: return 1;
    }
  }
  private normCount(v: number): number { const COUNT_SAT = 10; return Math.min(v / COUNT_SAT, 1); }
  private normCompact(avgDist: number): number { const COMPACT_SAT_M = this.CLUSTER_RADIUS_M; return Math.max(0, 1 - (avgDist / COMPACT_SAT_M)); }
  private normSeverity(avgSeverity: number): number { return Math.min(Math.max(avgSeverity / 10, 0), 1); }
  private normRecency(avgAgeDays: number): number { return Math.max(0, 1 - Math.min(avgAgeDays / 30, 1)); }

private effectiveSeverity(p: PointEx): number {
    const baseSeverity = this.incidentScore(p.category || '');
    if (p.status !== 'resolved') return Math.round(baseSeverity * 10) / 10;
    const resolvedDate = p.when;
    if (!resolvedDate) return Math.round(baseSeverity * 10) / 10;
    const today = new Date();
    const daysSinceResolved = Math.floor((today.getTime() - new Date(resolvedDate).getTime()) / (1000 * 3600 * 24));
    const periodsPassed = Math.floor(daysSinceResolved / 8);
    // Reduce by 35% each 8-day period (multiply by 0.65)
    const severityReductionMultiplier = Math.pow(0.65, periodsPassed);
    const effectiveSeverity = baseSeverity * severityReductionMultiplier;
    return Math.round(effectiveSeverity * 10) / 10;
  }
  
  private getResolvedOpacity(p: PointEx): number {
    if (p.status !== 'resolved') return 1;
    const resolvedDate = p.when;
    if (!resolvedDate) return 1;
    const today = new Date();
    const daysSinceResolved = Math.floor((today.getTime() - new Date(resolvedDate).getTime()) / (1000 * 3600 * 24));
    const periodsPassed = Math.floor(daysSinceResolved / 8);
    // Fade opacity by 35% each 8-day period (multiply by 0.65)
    const opacityMultiplier = Math.pow(0.65, periodsPassed);
    return Math.max(0.1, opacityMultiplier); // Minimum 10% opacity
  }

  private drawClusters(clusters: ClusterEx[], seqCheck: number) {
    this.clusterLayer.clearLayers();
    if (!clusters.length) return;
    type Scored = { c: ClusterEx; count: number; avgD: number; avgPreScore: number; score: number; };
    const scored: Scored[] = clusters.map((c) => {
      const ws = c.points.map(p => this.getResolvedOpacity(p));
      const sumW = ws.reduce((a, b) => a + b, 0) || 1;
      const avgPreScore = c.points.reduce((s, p) => s + this.preClusterDangerScore(p), 0) / c.points.length;
      const wCount = Math.min(sumW, 8);
      const avgD = c.points.reduce((s, p, i) => s + ws[i] * this.haversine(p.lat, p.lng, c.center.lat, c.center.lng), 0) / sumW;
      const sCount = this.normCount(wCount);
      const sCompact = this.normCompact(avgD);
      const W = this.SCORE_WEIGHTS;
      const finalScore = Math.min(avgPreScore + ((W.count * sCount) + (W.compact * sCompact)) * 0.5, 1);
      return { c, count: c.points.length, avgD, avgPreScore, score: finalScore };
    });

    const t1 = 0.35, t2 = 0.50;
    if (seqCheck !== this._renderSeq) return;

    scored.forEach(({ c, count, avgD, avgPreScore, score }) => {
      if (score < this.VISIBLE_FLOOR) return;
      const color = score < t1 ? '#ffff00' : score < t2 ? '#ffa500' : '#ff0000';
      const riskLabel = score < t1 ? 'Low' : score < t2 ? 'Medium' : 'High';
      const isInteractive = !this.tapEnabled;

      const ring = L.circle([c.center.lat, c.center.lng], {
        color, fillColor: color, fillOpacity: 0.45, radius: this.CLUSTER_RADIUS_M,
        bubblingMouseEvents: isInteractive, interactive: isInteractive, renderer: this.canvasRenderer,
      }).addTo(this.clusterLayer);

      ring.on('click', (e: L.LeafletMouseEvent) => {
        if (this.tapEnabled) return;
        const html = `
          <div style="font: 16px/1.3 system-ui;">
            <div style="font-weight:700;margin-bottom:6px;">Cluster Summary</div>
            <div><b>Danger Level:</b> ${riskLabel}</div>
            <div><b>Final Danger Score:</b> ${score.toFixed(3)}</div>
            <div><b>Avg. Preliminary Score:</b> ${avgPreScore.toFixed(3)}</div>
            <div><b>Total Incidents:</b> ${count}</div>
            <div><b>Avg. Spread:</b> ${avgD.toFixed(0)} m</div>
          </div>
        `;
        this.sharedPopup.setLatLng(ring.getLatLng()).setContent(html);
        this.map.openPopup(this.sharedPopup);
      });
    });
  }

  private llToXYFactory(points: {lat:number; lng:number}[]) {
    const lat0 = points.reduce((s,p)=>s+p.lat,0)/points.length;
    const lon0 = points.reduce((s,p)=>s+p.lng,0)/points.length;
    const cos = Math.cos(lat0 * Math.PI/180);
    const R = 6371000;
    const toXY = (lat:number,lng:number)=>({ x: R * (lng - lon0) * Math.PI/180 * cos, y: R * (lat - lat0) * Math.PI/180 });
    const toLL = (x:number,y:number)=>({ lat: lat0 + (y / R) * 180/Math.PI, lng: lon0 + (x / (R * cos)) * 180/Math.PI });
    return { toXY, toLL };
  }

  private preClusterDangerScore(p: PointEx): number {
    const W = this.SCORE_WEIGHTS;
    const baseSeverity = this.incidentScore(p.category || '');
    const now = new Date();
    const reportDate = this.toDate(p.datetime) || new Date();
    const ageDays = Math.max(0, (now.getTime() - reportDate.getTime()) / (1000 * 3600 * 24));
    const sSeverity = Math.min(Math.max(baseSeverity / 10, 0), 1);
    const sRecency  = Math.max(0, 1 - Math.min(ageDays / 30, 1));
    const score = (W.severity * sSeverity) + (W.recency * sRecency);
    return Math.min(score / (W.severity + W.recency), 1);
  }

  private buildReportPopup(p: PointEx): string {
    const dt = p.when ? this.formatDateTime(p.when) : '—';
    const cat = p.category || '—';
    const brgy = p.barangay || '—';
    const desc = (p.description && p.description.trim().length ? p.description : ' —');
    const sevBase = typeof p.severity === 'number' ? p.severity : this.incidentScore(p.category || '');
    const sevEff = this.effectiveSeverity(p);
    const sevText = (p.status === 'resolved') ? `${sevBase.toFixed(0)} / 10 (eff. ${sevEff.toFixed(1)})` : `${sevBase.toFixed(0)} / 10`;
    const st = (p.status || 'verified').toUpperCase();
    const lat = p.lat.toFixed(6);
    const lng = p.lng.toFixed(6);
    const preScore = this.preClusterDangerScore(p as any);
    const dangerLevel = preScore < 0.35 ? 'Low' : preScore < 0.50 ? 'Medium' : 'High';
    return `
      <div style="font: 16px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;">
        <div style="font-weight:700;margin-bottom:6px;">Incident Report</div>
        <div><b>Category: </b>${cat}</div>
        <div><b>Barangay: </b>${brgy}</div>
        <div><b>Description: </b>${this.escapeHtml(desc)}</div>
        <div><b>Severity: </b>${sevText}</div>
        <div><b>Preliminary Danger Score:</b> ${preScore.toFixed(3)} (${dangerLevel})</div>
        <div><b>Date / Time: </b>${dt}</div>
        <div><b>Coords: </b>${lat}, ${lng}</div>
        <div><b>Status: </b>${st}</div>
      </div>
    `;
  }

  private formatDateTime(d: Date): string {
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":"&#39;" } as any)[c]);
  }

  private coordsOf(r: ReportDoc): { lat: number; lng: number } | null {
    const toNum = (v:any)=> (typeof v==='number'?v: typeof v==='string'?parseFloat(v):NaN);
    const lat = toNum(r.lat); const lng = toNum(r.lng);
    return !isNaN(lat)&&!isNaN(lng) ? {lat,lng} : null;
  }

  private toDate(v:any): Date | undefined {
    if (!v) return undefined;
    if (v instanceof Date) return v;
    if (typeof (v as any)?.toDate === 'function') return (v as Timestamp).toDate();
    if (typeof v?.seconds === 'number') return new Date(v.seconds * 1000);
    const d = new Date(v); return isNaN(+d) ? undefined : d;
  }

  private haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) throw new Error('Invalid latitude or longitude values');
    const R = 6371000;
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private normalizeBarangay(name:string):string{
    const s=(name||'').trim().toLowerCase();
    if (s.startsWith('carig sur'))   return 'Carig Sur';
    if (s.startsWith('carig norte')) return 'Carig Norte';
    if (s.startsWith('linao east'))  return 'Linao East';
    if (s.startsWith('linao west'))  return 'Linao West';
    if (s.startsWith('linao norte')) return 'Linao Norte';
    return (name||'').trim();
  }

  private fitBarangay(){
    this.outlineLayer.clearLayers();
    const coords=this.POLYGONS[this.barangay];
    if(!coords||coords.length<3) return;
    const polygon=L.polygon(coords,{
      color:'#ff4d4f', dashArray:'6 6', weight:2,
      fillColor:'#ffb3b6', fillOpacity:.10,
      bubblingMouseEvents:true, interactive:true,
      renderer: this.canvasRenderer,
    }).addTo(this.outlineLayer);
    const b=polygon.getBounds();
    // @ts-ignore
    this.map.setMaxBounds(undefined as any);
    this.map.fitBounds(b,{padding:[20,20]});
    this.map.setMaxBounds(b.pad(0.05));
  }

  private isPointInsidePolygonLL(point: [number, number], polygon: [number, number][]): boolean {
    const [py, px] = point;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const yi = polygon[i][0], xi = polygon[i][1];
      const yj = polygon[j][0], xj = polygon[j][1];
      const intersect = ((yi > py) !== (yj > py)) && (px < (((xj - xi) * (py - yi)) / (yj - yi)) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  private isInsideAnyAllowed(lat: number, lng: number, allow: Set<string>): boolean {
    for (const name of allow) {
      const poly = this.POLYGONS[name];
      if (poly && this.isPointInsidePolygonLL([lat, lng], poly)) return true;
    }
    return false;
  }

  private async alert(header:string, message:string){
    const a=await this.alertCtrl.create({ header, message, buttons:['OK'] });
    await a.present();
  }
}