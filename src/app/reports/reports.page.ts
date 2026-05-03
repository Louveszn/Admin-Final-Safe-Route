import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import {
  Firestore,
  collection,
  collectionData,
  doc,
  deleteDoc,
  updateDoc,
  query,
  where,
  getDoc,
  getDocs,
} from '@angular/fire/firestore';
import { BehaviorSubject, Observable, combineLatest, map, switchMap, take } from 'rxjs';

type ReportStatus = 'pending' | 'verified' | 'resolved' | 'rejected';

interface Report {
  id: string;
  category: string;
  location?: string;
  datetime: number | string | any;
  status: ReportStatus;
  description?: string;
  barangay: string;
  landmark?: string;
  lat?: number;
  lng?: number;
  _dt?: number;
  userId?: string;
  reportedBy?: string;
  createdBy?: string;
  userName?: string;
  userAddress?: string;
  userContact?: string;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
}

interface UserInfo {
  name: string;
  address: string;
  contact: string;
  email: string;
  firstName: string;
  lastName: string;
}

@Component({
  selector: 'app-reports',
  templateUrl: './reports.page.html',
  styleUrls: ['./reports.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule],
})
export class ReportsPage {
  role: 'super_admin' | 'barangay_admin' = 'barangay_admin';
  barangay = '';
  barangayOptions = ['All Barangays', 'Carig Sur', 'Carig Norte', 'Linao East', 'Linao West', 'Linao Norte'];
  selectedBarangay = 'All Barangays';
  private barangayFilter$ = new BehaviorSubject<string>('All Barangays');

  activeTab: ReportStatus = 'pending';
  private tab$ = new BehaviorSubject<ReportStatus>('pending');
  searchTerm = '';
  private search$ = new BehaviorSubject<string>('');
  sortOrder: 'asc' | 'desc' = 'desc';
  private sort$ = new BehaviorSubject<'asc' | 'desc'>('desc');

  // Month filter properties
  selectedMonth = 'All Months';
  selectedYear = 'All Years';
  monthOptions: string[] = [];
  yearOptions: string[] = [];
  private monthFilter$ = new BehaviorSubject<string>('');

  reports$: Observable<Report[]>;
  filtered$: Observable<Report[]>;

  summaryOpen = false;
  selected: Report | null = null;

  currentAdminName = '';
  
  private userCache = new Map<string, UserInfo>();

  constructor(
    private fs: Firestore,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController
  ) {
    this.role = (localStorage.getItem('role') as any) || 'barangay_admin';
    this.barangay = this.normalizeBarangay(localStorage.getItem('barangay') || 'Carig Sur');
    this.currentAdminName = localStorage.getItem('adminName') || `${this.barangay} Barangay Admin`;

    // Initialize month and year options
    this.initializeMonthYearOptions();

    const colRef = collection(this.fs, 'reports');
    const base = this.role === 'super_admin'
      ? colRef
      : query(colRef, where('barangay', '==', this.barangay));

    const baseReports$ = collectionData(base, { idField: 'id' }) as Observable<Report[]>;
    
    this.reports$ = baseReports$.pipe(
      switchMap((reports) => {
        console.log(`Processing ${reports.length} reports...`);
        
        const enrichmentPromises = reports.map(async (report) => {
          console.log(`Processing report ${report.id}: userId=${report.userId}, reportedBy=${report.reportedBy}, createdBy=${report.createdBy}`);
          
          if (report.reportedBy === 'admin') {
            console.log(`Report ${report.id} was reported by admin`);
            return {
              ...report,
              userName: this.currentAdminName,
              userAddress: `${report.barangay} Barangay Office`,
              userContact: '—',
              userEmail: '—',
              userFirstName: '—',
              userLastName: '—'
            };
          }
          
          if (report.userId) {
            const userInfo = await this.fetchUserInfo(report.userId);
            
            if (userInfo.name.startsWith('Unknown User') && report.createdBy) {
              console.log(`UserId ${report.userId} not found, searching by email: ${report.createdBy}`);
              const userByEmail = await this.findUserByEmail(report.createdBy);
              if (userByEmail) {
                return {
                  ...report,
                  userName: userByEmail.name,
                  userAddress: userByEmail.address,
                  userContact: userByEmail.contact,
                  userEmail: userByEmail.email,
                  userFirstName: userByEmail.firstName,
                  userLastName: userByEmail.lastName
                };
              }
              
              const adminInfo = await this.checkIfCreatedByAdmin(report.createdBy, report.barangay);
              if (adminInfo) {
                return {
                  ...report,
                  userName: adminInfo.name,
                  userAddress: adminInfo.address,
                  userContact: '—',
                  userEmail: adminInfo.email,
                  userFirstName: adminInfo.firstName,
                  userLastName: adminInfo.lastName
                };
              }
            }
            
            return {
              ...report,
              userName: userInfo.name,
              userAddress: userInfo.address,
              userContact: userInfo.contact,
              userEmail: userInfo.email,
              userFirstName: userInfo.firstName,
              userLastName: userInfo.lastName
            };
          }
          
          if (report.createdBy) {
            const userByEmail = await this.findUserByEmail(report.createdBy);
            if (userByEmail) {
              return {
                ...report,
                userName: userByEmail.name,
                userAddress: userByEmail.address,
                userContact: userByEmail.contact,
                userEmail: userByEmail.email,
                userFirstName: userByEmail.firstName,
                userLastName: userByEmail.lastName
              };
            }
            
            const adminInfo = await this.checkIfCreatedByAdmin(report.createdBy, report.barangay);
            if (adminInfo) {
              return {
                ...report,
                userName: adminInfo.name,
                userAddress: adminInfo.address,
                userContact: '—',
                userEmail: adminInfo.email,
                userFirstName: adminInfo.firstName,
                userLastName: adminInfo.lastName
              };
            }
          }
          
          return {
            ...report,
            userName: '—',
            userAddress: '—',
            userContact: '—',
            userEmail: '—',
            userFirstName: '—',
            userLastName: '—'
          };
        });
        
        return Promise.all(enrichmentPromises);
      })
    );

    this.filtered$ = combineLatest([
      this.reports$, this.tab$, this.search$, this.sort$, this.barangayFilter$, this.monthFilter$
    ]).pipe(
      map(([rows, tab, q, order, brgySel, monthYearFilter]) => {
        console.log('=== FILTER DEBUG ===');
        console.log('Month/Year Filter:', monthYearFilter);
        console.log('Total reports before filtering:', rows.length);
        
        const term = (q || '').trim().toLowerCase();
        const selected = this.normalizeBarangay(brgySel || 'All Barangays');
        
        let filtered = rows
          .filter(r => (r.status || 'pending') === tab)
          .filter(r =>
            !term
              ? true
              : (r.category || '').toLowerCase().includes(term) ||
                (r.location || '').toLowerCase().includes(term) ||
                (r.landmark || '').toLowerCase().includes(term) ||
                (r.barangay || '').toLowerCase().includes(term) ||
                (r.description || '').toLowerCase().includes(term) ||
                (r.userName || '').toLowerCase().includes(term)
          )
          .filter(r => {
            if (this.role !== 'super_admin') return true;
            if (!selected || selected === 'All Barangays') return true;
            return this.normalizeBarangay(r.barangay || '') === selected;
          });
        
        console.log('After status/search/barangay filters:', filtered.length);
        
        // Apply month/year filter
        if (monthYearFilter && monthYearFilter.trim() !== '') {
          filtered = filtered.filter(r => {
            const reportDate = new Date(this.toMillis(r.datetime));
            const reportYear = reportDate.getFullYear();
            const reportMonth = String(reportDate.getMonth() + 1).padStart(2, '0');
            const reportMonthYear = `${reportYear}-${reportMonth}`;
            
            const matches = reportMonthYear === monthYearFilter;
            if (!matches) {
              console.log(`Filtering out: ${r.category} from ${reportMonthYear} (looking for ${monthYearFilter})`);
            }
            return matches;
          });
          console.log('After month/year filter:', filtered.length);
        }
        
        return filtered
          .map(r => ({ ...r, _dt: this.toMillis(r.datetime) }))
          .sort((a, b) =>
            order === 'desc' ? (b._dt || 0) - (a._dt || 0) : (a._dt || 0) - (b._dt || 0)
          );
      })
    );
  }

  initializeMonthYearOptions() {
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    this.monthOptions = ['All Months', ...months];

    const currentYear = new Date().getFullYear();
    this.yearOptions = ['All Years'];
    for (let year = currentYear; year >= currentYear - 5; year--) {
      this.yearOptions.push(year.toString());
    }
  }

  onMonthChange(month: string) {
    this.selectedMonth = month;
    this.updateMonthFilter();
  }

  onYearChange(year: string) {
    this.selectedYear = year;
    this.updateMonthFilter();
  }

  private updateMonthFilter() {
    // If either filter is set to "All", clear the filter
    if (!this.selectedMonth || !this.selectedYear || 
        this.selectedMonth === 'All Months' || this.selectedYear === 'All Years') {
      this.monthFilter$.next('');
      return;
    }

    // Get the month index (January = 1, February = 2, etc.)
    const monthIndex = this.monthOptions.indexOf(this.selectedMonth);
    
    // monthOptions[0] is 'All Months', so actual months start at index 1
    if (monthIndex > 0) {
      const monthStr = String(monthIndex).padStart(2, '0');
      const filterValue = `${this.selectedYear}-${monthStr}`;
      console.log('Setting month filter to:', filterValue);
      this.monthFilter$.next(filterValue);
    } else {
      this.monthFilter$.next('');
    }
  }

  setTab(tab: ReportStatus) { this.activeTab = tab; this.tab$.next(tab); }
  onSearch(q: string) { this.search$.next(q ?? ''); }
  onBarangayChange(v: string) { this.selectedBarangay = v; this.barangayFilter$.next(v || 'All Barangays'); }
  toggleSort() { this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc'; this.sort$.next(this.sortOrder); }

  async openSummary(r: Report) { 
    this.selected = r;
    this.summaryOpen = true;
  }
  
  closeSummary() { 
    this.summaryOpen = false; 
    this.selected = null;
  }

// Updated printReports() method - replace in reports.page.ts

printReports() {
  this.filtered$.pipe(take(1)).subscribe(reports => {
    if (!reports || reports.length === 0) {
      this.toast('No reports to print', true);
      return;
    }

    const monthYearText = this.selectedMonth && this.selectedMonth !== 'All Months' && 
                         this.selectedYear && this.selectedYear !== 'All Years'
      ? `${this.selectedMonth} ${this.selectedYear}`
      : 'All Time';

    const barangayText = this.role === 'super_admin' && this.selectedBarangay !== 'All Barangays'
      ? this.selectedBarangay
      : this.role === 'barangay_admin'
        ? this.barangay
        : 'All Barangays';

    let tableRows = '';
    reports.forEach(r => {
      tableRows += `
        <tr>
          <td><strong>${this.escapeHtml(r.category)}</strong></td>
          <td>${this.escapeHtml(r.landmark || '—')}</td>
          <td>${this.escapeHtml(r.barangay || '—')}</td>
          <td>${this.escapeHtml(r.description || 'No description')}</td>
          <td>${this.escapeHtml(this.dateOnly(r.datetime))}</td>
          <td>${this.escapeHtml(this.timeOnly(r.datetime))}</td>
        </tr>
      `;
    });

    const html = `<!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>SafeRoute Incident Report - ${this.escapeHtml(monthYearText)}</title>
          <style>
            @page { 
              margin: 15mm;
              size: A4;
            } 

            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }

            html, body { 
              height: 100%;
              width: 100%;
            }
            
            body {
              font-family: 'Segoe UI', Arial, Helvetica, sans-serif;
              font-size: 11pt;          
              line-height: 1.4;
              display: flex;
              flex-direction: column;
              align-items: center;
              padding: 20pt;
              background: white;
              color: #182f58;
            }

            .content-wrapper {
              width: 100%;
              max-width: 1000px;
              margin: 0 auto;
            }

            /* Header Styling */
            .header {
              text-align: center;
              margin-bottom: 20pt;
              padding-bottom: 16pt;
              border-bottom: 3px solid #1e3a5f;
            }

            .header h1 {
              font-size: 32pt;
              font-weight: 700;
              color: #1e3a5f;
              margin-bottom: 4pt;
              letter-spacing: -0.3px;
            }

            .header h2 {
              font-size: 18pt;
              font-weight: 400;
              color: #5facb6;
              margin-bottom: 14pt;
              letter-spacing: 0.2px;
            }

            .header .subtitle {
              font-size: 10.5pt;
              color: #4a5568;
              margin: 1pt 0;
              font-weight: 400;
              line-height: 1.6;
            }

            /* Summary Info Styling */
            .summary-info {
              background: #d6eaf8 !important;
              border: 1px solid #85b3c9;
              border-radius: 3pt;
              padding: 10pt 14pt;
              margin-bottom: 18pt;
              display: flex;
              justify-content: space-between;
              align-items: center;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }

            .summary-info p {
              margin: 0;
              font-size: 9pt;
              color: #1a3a52;
              font-weight: 700;
            }

            .summary-info strong {
              color: #0d2438;
              font-weight: 700;
            }
            
            /* Table Styling */
            table {
              width: 100%;
              border-collapse: collapse;
              table-layout: auto;
              margin: 0 auto;
            }
            
            th {
              background-color: #1e3a5f !important;
              color: #ffffff !important;
              font-size: 9.5pt;
              font-weight: 700;
              padding: 10pt 8pt;
              border: 1px solid #1e3a5f;
              text-align: left;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }

            td {
              border: 1px solid #cfd8dc;
              padding: 8pt;
              font-size: 9pt;
              color: #182f58;
              vertical-align: top;
            }
            
            tbody tr:nth-child(even) {
              background-color: #ffffff;
            }

            tbody tr:nth-child(odd) {
              background-color: #fafbfc;
            }

            tbody td:first-child {
              font-weight: 700;
              color: #0d1b2a;
            }

            td:nth-child(5), td:nth-child(6) {
              text-align: center;
              font-family: 'Courier New', monospace;
            }
            
            tr, td, th { 
              page-break-inside: avoid; 
            }
          </style>
        </head>
        <body>
          <div class="content-wrapper">
            <div class="header">
              <h1>SafeRoute</h1>
              <h2>Incident Report</h2>
              <div class="subtitle">Period: ${this.escapeHtml(monthYearText)}</div>
              <div class="subtitle">Barangay: ${this.escapeHtml(barangayText)}</div>
              <div class="subtitle">Status: ${this.escapeHtml(this.activeTab.charAt(0).toUpperCase() + this.activeTab.slice(1))}</div>
            </div>
            
            <div class="summary-info">
              <p><strong>Total Reports:</strong> ${reports.length}</p>
              <p><strong>Generated:</strong> ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}</p>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Landmark</th>
                  <th>Barangay</th>
                  <th>Description</th>
                  <th>Date</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                ${tableRows}
              </tbody>
            </table>
          </div>
        </body>
      </html>
    `;

    const printWindow = window.open('', '_blank', 'width=1100,height=1400');
    if (!printWindow) {
      this.toast('Could not open print window. Please allow pop-ups.', true);
      return;
    }
    
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    
    // Listen for cancel event from print dialog
    printWindow.onbeforeunload = () => {
      // Clean up when window is closing
    };
    
    printWindow.onload = () => {
      printWindow.focus();
      
      printWindow.onafterprint = () => {
        setTimeout(() => {
          printWindow.close();
        }, 200);
      };
      
      setTimeout(() => {
        printWindow.print();
      }, 200);
    };
  });
}

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  printSummary() {
    this.hideMenuForPrint();
    document.body.classList.add('print-summary-mode');
    
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        document.body.classList.remove('print-summary-mode');
        this.restoreMenuAfterPrint();
      }, 1000);
    }, 100);
  }

  private hideMenuForPrint() {
    const menus = document.querySelectorAll('ion-menu, ion-split-pane ion-menu, [slot="start"]');
    menus.forEach((menu: any) => {
      menu.style.display = 'none';
      menu.style.visibility = 'hidden';
      menu.setAttribute('data-print-hidden', 'true');
    });
    
    const splitPanes = document.querySelectorAll('ion-split-pane');
    splitPanes.forEach((pane: any) => {
      pane.style.setProperty('--side-width', '0px', 'important');
    });
    
    const contents = document.querySelectorAll('ion-content, .main-content');
    contents.forEach((content: any) => {
      content.style.marginLeft = '0';
      content.style.width = '100%';
    });
  }

  private restoreMenuAfterPrint() {
    const hiddenMenus = document.querySelectorAll('[data-print-hidden="true"]');
    hiddenMenus.forEach((menu: any) => {
      menu.style.display = '';
      menu.style.visibility = '';
      menu.removeAttribute('data-print-hidden');
    });
    
    const splitPanes = document.querySelectorAll('ion-split-pane');
    splitPanes.forEach((pane: any) => {
      pane.style.removeProperty('--side-width');
    });
    
    const contents = document.querySelectorAll('ion-content, .main-content');
    contents.forEach((content: any) => {
      content.style.marginLeft = '';
      content.style.width = '';
    });
  }

  async checkIfCreatedByAdmin(email: string, reportBarangay: string): Promise<UserInfo | null> {
    try {
      console.log(`Checking if ${email} is an admin`);
      
      const adminsRef = collection(this.fs, 'admins');
      const q = query(adminsRef, where('email', '==', email));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const adminData = querySnapshot.docs[0].data();
        console.log(`Found admin:`, adminData);
        
        const barangayName = this.normalizeBarangay(reportBarangay || adminData['barangay'] || 'Unknown');
        
        return {
          name: adminData['name'] || adminData['fullName'] || `${barangayName} Admin`,
          address: `${barangayName}, Barangay Hall`,
          contact: '—',
          email: adminData['email'] || email || '—',
          firstName: adminData['firstName'] || adminData['first_name'] || '—',
          lastName: adminData['lastName'] || adminData['last_name'] || '—'
        };
      }
      
      console.log(`${email} is not an admin`);
      return null;
    } catch (error) {
      console.error('Error checking admin status:', error);
      return null;
    }
  }

  async findUserByEmail(email: string): Promise<UserInfo | null> {
    try {
      console.log(`Searching for user by email: ${email}`);
      
      const usersRef = collection(this.fs, 'users');
      const q = query(usersRef, where('email', '==', email));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const userData = querySnapshot.docs[0].data();
        console.log(`Found user by email:`, userData['username'] || userData['name']);
        
        const userInfo: UserInfo = {
          name: userData['name'] || userData['fullName'] || userData['displayName'] || userData['username'] || userData['email']?.split('@')[0] || '—',
          address: userData['address'] || '—',
          contact: userData['phone'] || userData['contact'] || userData['phoneNumber'] || '—',
          email: userData['email'] || email || '—',
          firstName: userData['firstName'] || userData['first_name'] || '—',
          lastName: userData['lastName'] || userData['last_name'] || '—'
        };
        
        return userInfo;
      }
      
      console.log(`No user found with email: ${email}`);
      return null;
    } catch (error) {
      console.error('Error finding user by email:', error);
      return null;
    }
  }

  async fetchUserInfo(userId: string): Promise<UserInfo> {
    if (this.userCache.has(userId)) {
      console.log(`Using cached user info for ${userId}`);
      return this.userCache.get(userId)!;
    }

    console.log(`Fetching user info for ${userId}`);
    try {
      const userDocRef = doc(this.fs, 'users', userId);
      const userDoc = await getDoc(userDocRef);
      
      let userInfo: UserInfo;
      
      if (userDoc.exists()) {
        const userData = userDoc.data();
        userInfo = {
          name: userData['name'] || userData['fullName'] || userData['displayName'] || userData['username'] || userData['email']?.split('@')[0] || '—',
          address: userData['address'] || '—',
          contact: userData['phone'] || userData['contact'] || userData['phoneNumber'] || '—',
          email: userData['email'] || '—',
          firstName: userData['firstName'] || userData['first_name'] || '—',
          lastName: userData['lastName'] || userData['last_name'] || '—'
        };
        console.log(`Successfully fetched user ${userId}:`, userInfo.name);
      } else {
        console.warn('User document not found for userId:', userId);
        userInfo = {
          name: `Unknown User (${userId.substring(0, 8)}...)`,
          address: '—',
          contact: '—',
          email: '—',
          firstName: '—',
          lastName: '—'
        };
      }
      
      this.userCache.set(userId, userInfo);
      return userInfo;
      
    } catch (error: any) {
      console.error('Error fetching user info:', error);
      
      const fallbackInfo: UserInfo = {
        name: error?.code === 'permission-denied' ? 'Permission Denied' : '—',
        address: '—',
        contact: '—',
        email: '—',
        firstName: '—',
        lastName: '—'
      };
      
      this.userCache.set(userId, fallbackInfo);
      return fallbackInfo;
    }
  }

  getReporterInfo(): { name: string; address: string; contact: string; email: string; firstName: string; lastName: string } {
    if (!this.selected) {
      return { name: '—', address: '—', contact: '—', email: '—', firstName: '—', lastName: '—' };
    }

    return {
      name: this.selected.userName || '—',
      address: this.selected.userAddress || '—',
      contact: this.selected.userContact || '—',
      email: this.selected.userEmail || '—',
      firstName: this.selected.userFirstName || '—',
      lastName: this.selected.userLastName || '—'
    };
  }

  async confirmStatusChange(r: Report, status: ReportStatus) {
    const action = status === 'verified' ? 'verify' : status === 'resolved' ? 'resolve' : 'reject';
    const alert = await this.alertCtrl.create({
      header: 'Confirmation',
      message: `Are you sure you want to ${action} this report?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Yes',
          handler: () => this.markStatus(r, status),
        },
      ],
    });
    await alert.present();
  }

  async confirmDelete(id: string) {
    const alert = await this.alertCtrl.create({
      header: 'Delete Report',
      message: 'Are you sure you want to permanently delete this report?',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => this.deleteReport(id),
        },
      ],
    });
    await alert.present();
  }

  async markStatus(r: Report, status: ReportStatus) {
    try {
      await updateDoc(doc(this.fs, 'reports', r.id), { status });
      this.toast(`Marked ${status}.`);
      if (this.selected?.id === r.id) this.selected.status = status;
    } catch (e: any) {
      this.toast(e?.message || 'Could not update status.', true);
    }
  }

  async deleteReport(id: string) {
    try {
      await deleteDoc(doc(this.fs, 'reports', id));
      this.toast('Report deleted.');
      this.closeSummary();
    } catch (e: any) {
      this.toast(e?.message || 'Could not delete report.', true);
    }
  }

  private normalizeBarangay(name: string): string {
    const s = (name || '').trim().toLowerCase();
    if (s.startsWith('carig sur')) return 'Carig Sur';
    if (s.startsWith('carig norte')) return 'Carig Norte';
    if (s.startsWith('linao east')) return 'Linao East';
    if (s.startsWith('linao west')) return 'Linao West';
    if (s.startsWith('linao norte')) return 'Linao Norte';
    if (s === 'all barangays' || s === 'all') return 'All Barangays';
    return (name || '').trim();
  }

  private toMillis(dt: any): number {
    if (!dt) return 0;
    if (typeof dt === 'number') return dt < 1e12 ? dt * 1000 : dt;
    if (dt && typeof dt.seconds === 'number')
      return dt.seconds * 1000 + Math.floor((dt.nanoseconds || 0) / 1e6);
    const n = Date.parse(dt);
    return isNaN(n) ? 0 : n;
  }

  dateOnly(dt: any): string {
    const ms = this.toMillis(dt);
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: '2-digit' });
  }

  timeOnly(dt: any): string {
    const ms = this.toMillis(dt);
    if (!ms) return '';
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  badgeClass(status?: ReportStatus) {
    const s = status || 'pending';
    return {
      pending: 'badge badge--pending',
      verified: 'badge badge--verified',
      resolved: 'badge badge--resolved',
      rejected: 'badge badge--rejected',
    }[s];
  }

  private async toast(message: string, danger = false) {
    const t = await this.toastCtrl.create({
      message,
      duration: 1500,
      color: danger ? 'danger' : 'dark',
      position: 'bottom',
    });
    await t.present();
  }
}