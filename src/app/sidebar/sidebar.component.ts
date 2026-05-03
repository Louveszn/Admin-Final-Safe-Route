import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, LoadingController, ToastController, AlertController } from '@ionic/angular';
import { RouterModule, Router } from '@angular/router';
import { getAuth, signOut } from 'firebase/auth';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [IonicModule, CommonModule, RouterModule],
  templateUrl: './sidebar.component.html',
  styleUrls: ['./sidebar.component.scss'],
})
export class SidebarComponent implements OnDestroy {
  loggingOut = false;
  private forceNavTimer?: any;

  constructor(
    private router: Router,
    private loadingCtrl: LoadingController,
    private toast: ToastController,
    private alertCtrl: AlertController
  ) {}

  async logout() {
    const confirm = await this.alertCtrl.create({
      header: 'Log Out',
      message: 'Are you sure you want to log out?',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel',
        },
        {
          text: 'Log Out',
          role: 'confirm',
          handler: () => this.performLogout(),
        },
      ],
    });

    await confirm.present();
  }

  private async performLogout() {
    if (this.loggingOut) return;
    this.loggingOut = true;

    // Kick off signOut (don't block UI on slow networks)
    const auth = getAuth();
    const signOutPromise = signOut(auth).catch(() => { /* swallow, we hard-fallback */ });

    // Clear local state fast (non-blocking)
    const localCleanup = Promise.resolve().then(() => {
      try {
        const keys = ['barangay', 'userRole', 'email'];
        keys.forEach(k => localStorage.removeItem(k));
        sessionStorage.clear();
      } catch {}
    });

    // Navigate to login right away for snappy UX
    const navPromise = this.router.navigateByUrl('/login', { replaceUrl: true });

    // Cap perceived wait: race all with a short timeout
    await Promise.race([
      Promise.allSettled([signOutPromise, localCleanup, navPromise]),
      new Promise(res => setTimeout(res, 800)), // ~0.8s cap
    ]);

    // Hard fallback in case router didn't move (rare)
    this.forceNavTimer = setTimeout(() => {
      if (location.pathname !== '/login') {
        window.location.replace('/login');
      }
    }, 1200);
  }

  ngOnDestroy(): void {
    if (this.forceNavTimer) clearTimeout(this.forceNavTimer);
  }
}