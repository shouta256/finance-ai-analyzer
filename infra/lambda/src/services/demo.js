"use strict";

const crypto = require("crypto");
const { DAY_MS } = require("../utils/constants");

/**
 * Build demo transactions for sandbox/demo users
 */
function buildStubTransactions(userId) {
  const now = new Date();
  const todayDate = now.getUTCDate();
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  
  const addDays = (days, offsetMs = 0) => {
    if (days > todayDate) return null;
    return new Date(anchor + (days - 1) * DAY_MS + offsetMs).toISOString();
  };
  
  const prevMonth = (monthsBack, day) => {
    const d = new Date(anchor);
    d.setUTCMonth(d.getUTCMonth() - monthsBack);
    d.setUTCDate(day);
    return d.toISOString();
  };
  
  const primaryAccount = crypto.randomUUID();
  const creditCard = crypto.randomUUID();
  const savings = crypto.randomUUID();

  const transactions = [];
  
  const addTx = (accountId, merchantName, amount, occurredAt, category, description, pending = false) => {
    if (!occurredAt) return;
    transactions.push({
      id: crypto.randomUUID(),
      userId,
      accountId,
      merchantName,
      amount,
      currency: "USD",
      occurredAt,
      authorizedAt: occurredAt,
      pending,
      category,
      description,
      notes: null,
      anomalyScore: null,
    });
  };

  // ===== Current Month (only up to today) =====
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, addDays(1), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, addDays(15), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "City Apartments", -1850.00, addDays(3), "Housing", "Monthly rent");
  addTx(primaryAccount, "Utility Power Co", -145.50, addDays(8), "Utilities", "Electric bill");
  addTx(primaryAccount, "Comcast Xfinity", -89.99, addDays(10), "Utilities", "Internet service");
  addTx(primaryAccount, "Blue Bottle Coffee", -8.75, addDays(2), "Dining", "Latte");
  addTx(primaryAccount, "Blue Bottle Coffee", -12.50, addDays(6), "Dining", "Coffee and pastry");
  addTx(primaryAccount, "Blue Bottle Coffee", -9.25, addDays(12), "Dining", "Cappuccino");
  addTx(primaryAccount, "Whole Foods Market", -156.32, addDays(5), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -89.47, addDays(12), "Groceries", "Mid-week restock");
  addTx(primaryAccount, "Trader Joes", -72.18, addDays(9), "Groceries", "Snacks and essentials");
  addTx(primaryAccount, "Uber Technologies", -24.50, addDays(4), "Transport", "Ride to downtown");
  addTx(primaryAccount, "Uber Technologies", -18.75, addDays(11), "Transport", "Ride to airport");
  addTx(primaryAccount, "Shell Gas Station", -52.40, addDays(7), "Transport", "Gas fill-up");
  addTx(creditCard, "Netflix", -15.99, addDays(2), "Entertainment", "Monthly subscription");
  addTx(creditCard, "Spotify", -10.99, addDays(3), "Entertainment", "Premium subscription");
  addTx(creditCard, "Amazon", -145.99, addDays(8), "Shopping", "Household items");
  addTx(creditCard, "Amazon", -67.50, addDays(14), "Shopping", "Books and electronics");
  addTx(creditCard, "Target", -89.32, addDays(6), "Shopping", "Home goods");
  addTx(creditCard, "Chipotle", -14.25, addDays(5), "Dining", "Lunch");
  addTx(creditCard, "Olive Garden", -48.75, addDays(9), "Dining", "Dinner with friends");
  addTx(savings, "Auto Transfer", -500.00, addDays(2), "Transfer", "Monthly savings transfer");
  addTx(primaryAccount, "Gym Membership", -49.99, addDays(1), "Health", "Monthly membership");
  addTx(creditCard, "CVS Pharmacy", -32.45, addDays(7), "Health", "Prescriptions");

  // ===== Previous Month (-1) =====
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(1, 1), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(1, 15), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "City Apartments", -1850.00, prevMonth(1, 3), "Housing", "Monthly rent");
  addTx(primaryAccount, "Utility Power Co", -132.80, prevMonth(1, 8), "Utilities", "Electric bill");
  addTx(primaryAccount, "Comcast Xfinity", -89.99, prevMonth(1, 10), "Utilities", "Internet service");
  addTx(primaryAccount, "Whole Foods Market", -178.45, prevMonth(1, 4), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -95.23, prevMonth(1, 11), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -112.67, prevMonth(1, 18), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Trader Joes", -68.90, prevMonth(1, 7), "Groceries", "Organic produce");
  addTx(primaryAccount, "Blue Bottle Coffee", -10.50, prevMonth(1, 5), "Dining", "Coffee");
  addTx(primaryAccount, "Blue Bottle Coffee", -8.75, prevMonth(1, 12), "Dining", "Latte");
  addTx(primaryAccount, "Starbucks", -7.45, prevMonth(1, 19), "Dining", "Frappuccino");
  addTx(creditCard, "Amazon", -234.56, prevMonth(1, 6), "Shopping", "Electronics");
  addTx(creditCard, "Amazon", -45.99, prevMonth(1, 14), "Shopping", "Books");
  addTx(creditCard, "Best Buy", -299.99, prevMonth(1, 20), "Shopping", "Headphones");
  addTx(creditCard, "Netflix", -15.99, prevMonth(1, 2), "Entertainment", "Monthly subscription");
  addTx(creditCard, "Spotify", -10.99, prevMonth(1, 3), "Entertainment", "Premium subscription");
  addTx(creditCard, "AMC Theatres", -32.00, prevMonth(1, 16), "Entertainment", "Movie night");
  addTx(primaryAccount, "Uber Technologies", -28.90, prevMonth(1, 9), "Transport", "Ride to meeting");
  addTx(primaryAccount, "Lyft", -22.50, prevMonth(1, 17), "Transport", "Airport ride");
  addTx(primaryAccount, "Shell Gas Station", -48.75, prevMonth(1, 13), "Transport", "Gas");
  addTx(savings, "Auto Transfer", -500.00, prevMonth(1, 2), "Transfer", "Monthly savings transfer");
  addTx(primaryAccount, "Gym Membership", -49.99, prevMonth(1, 1), "Health", "Monthly membership");
  addTx(creditCard, "Sushi Palace", -65.80, prevMonth(1, 21), "Dining", "Dinner");

  // ===== 2 Months Ago (-2) =====
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(2, 1), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(2, 15), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Freelance Project", 850.00, prevMonth(2, 22), "Income", "Side project payment");
  addTx(primaryAccount, "City Apartments", -1850.00, prevMonth(2, 3), "Housing", "Monthly rent");
  addTx(primaryAccount, "Utility Power Co", -118.45, prevMonth(2, 8), "Utilities", "Electric bill");
  addTx(primaryAccount, "Comcast Xfinity", -89.99, prevMonth(2, 10), "Utilities", "Internet service");
  addTx(primaryAccount, "Water Company", -45.00, prevMonth(2, 12), "Utilities", "Water bill");
  addTx(primaryAccount, "Whole Foods Market", -145.67, prevMonth(2, 5), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -88.34, prevMonth(2, 12), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Costco", -287.45, prevMonth(2, 19), "Groceries", "Bulk shopping");
  addTx(creditCard, "Delta Airlines", -425.00, prevMonth(2, 10), "Travel", "Flight to NYC");
  addTx(creditCard, "Airbnb", -320.00, prevMonth(2, 14), "Travel", "NYC accommodation");
  addTx(creditCard, "Amazon", -156.78, prevMonth(2, 7), "Shopping", "Various items");
  addTx(creditCard, "Apple Store", -129.00, prevMonth(2, 18), "Shopping", "AirPods case");
  addTx(creditCard, "Netflix", -15.99, prevMonth(2, 2), "Entertainment", "Monthly subscription");
  addTx(creditCard, "Spotify", -10.99, prevMonth(2, 3), "Entertainment", "Premium subscription");
  addTx(primaryAccount, "Uber Technologies", -42.30, prevMonth(2, 6), "Transport", "Ride");
  addTx(primaryAccount, "Shell Gas Station", -55.20, prevMonth(2, 15), "Transport", "Gas");
  addTx(savings, "Auto Transfer", -500.00, prevMonth(2, 2), "Transfer", "Monthly savings transfer");
  addTx(primaryAccount, "Gym Membership", -49.99, prevMonth(2, 1), "Health", "Monthly membership");

  // ===== 3 Months Ago (-3) =====
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(3, 1), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(3, 15), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "City Apartments", -1850.00, prevMonth(3, 3), "Housing", "Monthly rent");
  addTx(primaryAccount, "Utility Power Co", -156.90, prevMonth(3, 8), "Utilities", "Electric bill (AC season)");
  addTx(primaryAccount, "Comcast Xfinity", -89.99, prevMonth(3, 10), "Utilities", "Internet service");
  addTx(primaryAccount, "Whole Foods Market", -167.89, prevMonth(3, 4), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -134.56, prevMonth(3, 11), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -98.23, prevMonth(3, 18), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Trader Joes", -76.45, prevMonth(3, 25), "Groceries", "Specialty items");
  addTx(creditCard, "Amazon", -89.99, prevMonth(3, 5), "Shopping", "Home office supplies");
  addTx(creditCard, "IKEA", -456.78, prevMonth(3, 12), "Shopping", "Furniture");
  addTx(creditCard, "Netflix", -15.99, prevMonth(3, 2), "Entertainment", "Monthly subscription");
  addTx(creditCard, "Spotify", -10.99, prevMonth(3, 3), "Entertainment", "Premium subscription");
  addTx(creditCard, "Concert Tickets", -150.00, prevMonth(3, 20), "Entertainment", "Live show");
  addTx(primaryAccount, "Uber Technologies", -35.60, prevMonth(3, 7), "Transport", "Ride");
  addTx(primaryAccount, "Lyft", -28.90, prevMonth(3, 14), "Transport", "Ride");
  addTx(primaryAccount, "Shell Gas Station", -62.30, prevMonth(3, 21), "Transport", "Gas");
  addTx(savings, "Auto Transfer", -500.00, prevMonth(3, 2), "Transfer", "Monthly savings transfer");
  addTx(primaryAccount, "Gym Membership", -49.99, prevMonth(3, 1), "Health", "Monthly membership");
  addTx(creditCard, "Doctor Visit", -150.00, prevMonth(3, 16), "Health", "Annual checkup copay");

  return transactions;
}

/**
 * Build demo accounts for sandbox/demo users
 */
function buildStubAccounts(userId) {
  const now = new Date().toISOString();
  return [
    {
      id: crypto.randomUUID(),
      name: "Primary Checking",
      institution: "Chase Bank",
      balance: 8542.67,
      currency: "USD",
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: "Rewards Credit Card",
      institution: "American Express",
      balance: -1847.23,
      currency: "USD",
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: "High Yield Savings",
      institution: "Ally Bank",
      balance: 15230.00,
      currency: "USD",
      createdAt: now,
    },
  ];
}

module.exports = {
  buildStubTransactions,
  buildStubAccounts,
};
