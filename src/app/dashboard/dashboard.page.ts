import { Component, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { Firestore, collection, collectionData, query, where } from '@angular/fire/firestore';
import { Observable, map, Subscription } from 'rxjs';
import Chart from 'chart.js/auto';

type ReportStatus = 'pending' | 'verified' | 'resolved';

interface Report {
  id: string;
  category: string;
  barangay: string;
  status?: ReportStatus;
  datetime?: any;
  _dt?: number;
}

interface AnalyticsData {
  date: string;
  category: string;
  status: string;
  barangay: string;
  count: number;
}

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.page.html',
  styleUrls: ['./dashboard.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule, RouterModule, FormsModule],
})
export class DashboardPage implements AfterViewInit, OnDestroy {
  private reports$!: Observable<Report[]>;
  
  // Filters
  selectedDate = '';
  selectedDateISO = '';
  selectedCategory = '';
  selectedStatus = '';
  selectedBarangay = '';

  // Analytics data
  analyticsData: AnalyticsData[] = [];
  filteredData: AnalyticsData[] = [];
  
  // Unique values for dropdowns
  uniqueDates: string[] = [];
  uniqueCategories: string[] = [];
  uniqueStatuses: string[] = ['Pending', 'Verified', 'Resolved'];
  uniqueBarangays: string[] = ['Carig Sur', 'Carig Norte', 'Linao East', 'Linao West', 'Linao Norte'];

  // Safest barangay tracking
  safestBarangay = '';
  safestBarangayCount = 0;
  showSafestBanner = false;

  // Charts
  private dateChart?: Chart;
  private categoryChart?: Chart;
  private statusChart?: Chart;
  
  private sub?: Subscription;

  // Scope
  role: 'super_admin' | 'barangay_admin' = 'barangay_admin';
  barangay = '';

  constructor(private fs: Firestore) {
    this.role = (localStorage.getItem('role') as any) || 'barangay_admin';
    this.barangay = this.normalizeBarangay(localStorage.getItem('barangay') || '');

    const colRef = collection(this.fs, 'reports');
    const base = this.role === 'super_admin'
      ? colRef
      : query(colRef, where('barangay', '==', this.barangay));

    this.reports$ = (collectionData(base, { idField: 'id' }) as Observable<Report[]>)
      .pipe(map(rows => rows.map(r => ({ ...r, _dt: this.toMillis(r.datetime) }))));
  }

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.sub = this.reports$.subscribe(rows => {
        this.processAnalyticsData(rows);
        this.calculateSafestBarangay(rows);
        this.applyFilters();
        this.updateAllCharts();
      });
    }, 100);
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.dateChart?.destroy();
    this.categoryChart?.destroy();
    this.statusChart?.destroy();
  }

  // ---- Process raw data into analytics format ----
  private processAnalyticsData(rows: Report[]) {
    const dataMap = new Map<string, number>();
    const dates = new Set<string>();
    const categories = new Set<string>();

    rows.forEach(r => {
      const date = this.toDateOnly(r._dt);
      const category = (r.category || 'Uncategorized').trim();
      const status = this.capitalizeStatus(r.status || 'pending');
      const barangay = this.normalizeBarangay(r.barangay || '');
      
      dates.add(date);
      categories.add(category);

      const key = `${date}|${category}|${status}|${barangay}`;
      dataMap.set(key, (dataMap.get(key) || 0) + 1);
    });

    // Convert to array format
    this.analyticsData = [];
    dataMap.forEach((count, key) => {
      const [date, category, status, barangay] = key.split('|');
      this.analyticsData.push({ date, category, status, barangay, count });
    });

    // Sort dates descending (newest first)
    this.uniqueDates = Array.from(dates).sort((a, b) => {
      const dateA = new Date(a).getTime();
      const dateB = new Date(b).getTime();
      return dateB - dateA;
    });
    
    this.uniqueCategories = Array.from(categories).sort();
  }

  // ---- Apply filters ----
  applyFilters() {
    this.filteredData = this.analyticsData.filter(item => {
      if (this.selectedDate && item.date !== this.selectedDate) return false;
      if (this.selectedCategory && item.category !== this.selectedCategory) return false;
      if (this.selectedStatus && item.status !== this.selectedStatus) return false;
      if (this.selectedBarangay && item.barangay !== this.selectedBarangay) return false;
      return true;
    });
  }

  onFilterChange() {
    this.applyFilters();
    this.updateAllCharts();
  }

  onDateChange(event: any, modal: any) {
    const selectedDateStr = event.detail.value;
    if (selectedDateStr) {
      // Convert ISO date to MM/DD/YYYY format
      const date = new Date(selectedDateStr);
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      const yyyy = date.getFullYear();
      this.selectedDate = `${mm}/${dd}/${yyyy}`;
      this.selectedDateISO = selectedDateStr;
    } else {
      this.selectedDate = '';
      this.selectedDateISO = '';
    }
    this.onFilterChange();
    modal.dismiss();
  }

  openDatePicker() {
    // Modal will open automatically via trigger
  }

  clearFilters() {
    this.selectedDate = '';
    this.selectedDateISO = '';
    this.selectedCategory = '';
    this.selectedStatus = '';
    this.selectedBarangay = '';
    this.onFilterChange();
  }

  // ---- Calculate Safest Barangay (Last 7 Days) ----
  private calculateSafestBarangay(rows: Report[]) {
    const now = Date.now();
    const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);

    // Filter reports from last week
    const lastWeekReports = rows.filter(r => r._dt && r._dt >= oneWeekAgo);

    // Count incidents per barangay
    const barangayCount = new Map<string, number>();
    this.uniqueBarangays.forEach(b => barangayCount.set(b, 0));

    lastWeekReports.forEach(r => {
      const barangay = this.normalizeBarangay(r.barangay || '');
      if (barangay && this.uniqueBarangays.includes(barangay)) {
        barangayCount.set(barangay, (barangayCount.get(barangay) || 0) + 1);
      }
    });

    // Find barangay with least incidents
    let minCount = Infinity;
    let safest = '';
    
    barangayCount.forEach((count, barangay) => {
      if (count < minCount) {
        minCount = count;
        safest = barangay;
      }
    });

    this.safestBarangay = safest;
    this.safestBarangayCount = minCount === Infinity ? 0 : minCount;
    
    // Show banner if current user is from the safest barangay
    if (this.role === 'barangay_admin' && this.barangay === this.safestBarangay) {
      this.showSafestBanner = true;
    }
  }

  // ---- Chart: Incidents by Date ----
  private updateDateChart() {
    const ctx = (document.getElementById('dateChart') as HTMLCanvasElement | null)?.getContext('2d');
    if (!ctx) return;

    const dateMap = new Map<string, number>();
    this.filteredData.forEach(item => {
      dateMap.set(item.date, (dateMap.get(item.date) || 0) + item.count);
    });

    const sortedDates = Array.from(dateMap.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    
    const labels = sortedDates.map(([date]) => date);
    const data = sortedDates.map(([_, count]) => count);

    if (this.dateChart) {
      this.dateChart.data.labels = labels;
      this.dateChart.data.datasets[0].data = data;
      this.dateChart.update();
      return;
    }

    this.dateChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Incidents',
          data,
          borderColor: '#3e91a0',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { mode: 'index', intersect: false }
        }
      }
    });
  }

  // ---- Chart: Incidents by Category ----
  private updateCategoryChart() {
    const ctx = (document.getElementById('categoryChart') as HTMLCanvasElement | null)?.getContext('2d');
    if (!ctx) return;

    const categoryMap = new Map<string, number>();
    this.filteredData.forEach(item => {
      categoryMap.set(item.category, (categoryMap.get(item.category) || 0) + item.count);
    });

    const sortedCategories = Array.from(categoryMap.entries())
      .sort((a, b) => b[1] - a[1]);
    
    const labels = sortedCategories.map(([cat]) => cat);
    const data = sortedCategories.map(([_, count]) => count);

    const colors = [
      '#3e91a0', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
      '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16'
    ];

    if (this.categoryChart) {
      this.categoryChart.data.labels = labels;
      this.categoryChart.data.datasets[0].data = data;
      this.categoryChart.data.datasets[0].backgroundColor = colors;
      this.categoryChart.update();
      return;
    }

    this.categoryChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Incidents',
          data,
          backgroundColor: colors,
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, ticks: { stepSize: 1 } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { mode: 'index', intersect: false }
        }
      }
    });
  }

  // ---- Chart: Incidents by Status ----
  private updateStatusChart() {
    const ctx = (document.getElementById('statusChart') as HTMLCanvasElement | null)?.getContext('2d');
    if (!ctx) return;

    const statusMap = new Map<string, number>();
    this.filteredData.forEach(item => {
      statusMap.set(item.status, (statusMap.get(item.status) || 0) + item.count);
    });

    const labels = ['Pending', 'Verified', 'Resolved'];
    const data = labels.map(label => statusMap.get(label) || 0);
    const colors = ['#fbbf24', '#3e91a0', '#10b981'];

    if (this.statusChart) {
      this.statusChart.data.labels = labels;
      this.statusChart.data.datasets[0].data = data;
      this.statusChart.update();
      return;
    }

    this.statusChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: '#fff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { mode: 'index', intersect: false }
        }
      }
    });
  }

  private updateAllCharts() {
    setTimeout(() => {
      this.updateDateChart();
      this.updateCategoryChart();
      this.updateStatusChart();
    }, 50);
  }

  // ---- Get summary statistics ----
  get totalIncidents(): number {
    return this.filteredData.reduce((sum, item) => sum + item.count, 0);
  }

  get pendingCount(): number {
    return this.filteredData
      .filter(item => item.status === 'Pending')
      .reduce((sum, item) => sum + item.count, 0);
  }

  get verifiedCount(): number {
    return this.filteredData
      .filter(item => item.status === 'Verified')
      .reduce((sum, item) => sum + item.count, 0);
  }

  get resolvedCount(): number {
    return this.filteredData
      .filter(item => item.status === 'Resolved')
      .reduce((sum, item) => sum + item.count, 0);
  }

  // ---- Utilities ----
  private capitalizeStatus(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  private normalizeBarangay(name: string): string {
    const s = (name || '').trim().toLowerCase();
    if (s.startsWith('carig sur'))   return 'Carig Sur';
    if (s.startsWith('carig norte')) return 'Carig Norte';
    if (s.startsWith('linao east'))  return 'Linao East';
    if (s.startsWith('linao west'))  return 'Linao West';
    if (s.startsWith('linao norte')) return 'Linao Norte';
    return (name || '').trim();
  }

  private toMillis(dt: any): number {
    if (!dt) return 0;
    if (typeof dt === 'number') return dt < 1e12 ? dt * 1000 : dt;
    if (dt && typeof dt.seconds === 'number') {
      return dt.seconds * 1000 + Math.floor((dt.nanoseconds || 0) / 1e6);
    }
    const n = Date.parse(dt);
    return isNaN(n) ? 0 : n;
  }

  private toDateOnly(ms?: number): string {
    if (!ms) return '';
    const d = new Date(ms);
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }
}