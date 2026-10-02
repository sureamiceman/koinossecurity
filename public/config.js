// Public Supabase settings. The anon key is designed to be public;
// all data is protected by the row-level security rules in supabase/schema.sql.
// NEVER put the service_role key here.
window.KOINOS_CONFIG = {
  supabaseUrl: "https://kapowhcexzsgogvvchqv.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthcG93aGNleHpzZ29ndnZjaHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyODk5ODIsImV4cCI6MjEwNTg2NTk4Mn0.IjRi7jcrsS5vXvNcBJFJ85TVZuD1U7e4B1OsN2MQoK8",
  appVersion: "1.8.1",
  // Public half of the push-notification key pair (the private half is a Netlify secret).
  vapidPublicKey: "BJAKYRuDufBtgXeb_EADMNi6Gti6Y6BAsjpg1ruhlnB-kokxa-gYWaddR0tn8O6a0LZn0oiXd6PHM6sr62v-Ico"
};
