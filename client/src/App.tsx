import React, { useState, useEffect } from 'react';
import axios from 'axios';

// Type definitions for the data models shared with the backend services
interface User {
  id: string;
  name: string;
  email: string;
}

interface Product {
  id: string;
  name: string;
  price: number;
}

interface Order {
  id: string;
  userId: string;
  productId: string;
  quantity: number;
  status: string;
}

const App: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [userForm, setUserForm] = useState({ name: '', email: '' });
  const [productForm, setProductForm] = useState({ name: '', price: '' });
  const [orderForm, setOrderForm] = useState({ userId: '', productId: '', quantity: 1 });

  // Track which entity is currently being edited. When non-null the corresponding
  // form will update the existing record rather than creating a new one. Null
  // values indicate that the form will create a new record. The errorMessage
  // state stores messages returned from the backend (e.g. deletion failures).
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Base URLs for the services are loaded from environment variables. When
  // running via docker-compose the client accesses the services through
  // localhost and exposed ports on the host.
  const USER_SERVICE_URL = import.meta.env.VITE_USER_SERVICE_URL || '';
  const PRODUCT_SERVICE_URL = import.meta.env.VITE_PRODUCT_SERVICE_URL || '';
  const ORDER_SERVICE_URL = import.meta.env.VITE_ORDER_SERVICE_URL || '';

  // Fetch initial data on mount
  useEffect(() => {
    fetchUsers();
    fetchProducts();
    fetchOrders();
  }, []);

  // Poll for order updates every 5 seconds.  This allows the UI to reflect
  // transitions from PENDING to CONFIRMED without a manual refresh.
  useEffect(() => {
    const intervalId = setInterval(() => {
      fetchOrders();
    }, 5000);
    return () => clearInterval(intervalId);
  }, []);

  const fetchUsers = async () => {
    const res = await axios.get<User[]>(`${USER_SERVICE_URL}/users`);
    setUsers(res.data);
  };

  const fetchProducts = async () => {
    const res = await axios.get<Product[]>(`${PRODUCT_SERVICE_URL}/products`);
    setProducts(res.data);
  };

  const fetchOrders = async () => {
    const res = await axios.get(`${ORDER_SERVICE_URL}/orders`);
    setOrders(res.data);
  };

  const handleUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingUserId) {
      // Update existing user
      const res = await axios.put<User>(`${USER_SERVICE_URL}/users/${editingUserId}`, userForm);
      setUsers(users.map((u) => (u.id === editingUserId ? res.data : u)));
      setEditingUserId(null);
      setUserForm({ name: '', email: '' });
    } else {
      const res = await axios.post<User>(`${USER_SERVICE_URL}/users`, userForm);
      setUsers([...users, res.data]);
      setUserForm({ name: '', email: '' });
    }
    setErrorMessage(null);
  };

  const handleProductSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const priceValue = parseFloat(productForm.price);
    if (isNaN(priceValue)) return;
    if (editingProductId) {
      const res = await axios.put<Product>(`${PRODUCT_SERVICE_URL}/products/${editingProductId}`, { name: productForm.name, price: priceValue });
      setProducts(products.map((p) => (p.id === editingProductId ? res.data : p)));
      setEditingProductId(null);
      setProductForm({ name: '', price: '' });
    } else {
      const res = await axios.post<Product>(`${PRODUCT_SERVICE_URL}/products`, { name: productForm.name, price: priceValue });
      setProducts([...products, res.data]);
      setProductForm({ name: '', price: '' });
    }
    setErrorMessage(null);
  };

  const handleOrderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingOrderId) {
      const res = await axios.put(`${ORDER_SERVICE_URL}/orders/${editingOrderId}`, {
        userId: orderForm.userId,
        productId: orderForm.productId,
        quantity: Number(orderForm.quantity)
      });
      // Replace the updated order in the local state. The backend returns an
      // object containing the updated order along with optional user/product.
      setOrders(
        orders.map((entry) => {
          const id = entry.order?.id || entry.id;
          return id === editingOrderId ? res.data : entry;
        })
      );
      setEditingOrderId(null);
      setOrderForm({ userId: '', productId: '', quantity: 1 });
    } else {
      const res = await axios.post(`${ORDER_SERVICE_URL}/orders`, {
        userId: orderForm.userId,
        productId: orderForm.productId,
        quantity: Number(orderForm.quantity)
      });
      setOrders([...orders, res.data]);
      setOrderForm({ userId: '', productId: '', quantity: 1 });
    }
    setErrorMessage(null);
  };

  // When editing a user populate the form with the existing values
  const handleUserEdit = (user: User) => {
    setEditingUserId(user.id);
    setUserForm({ name: user.name, email: user.email });
    setErrorMessage(null);
  };

  // Delete a user and refresh local state. If the backend returns an error
  // (e.g. because the user has existing orders) it is displayed to the user.
  const handleUserDelete = async (id: string) => {
    try {
      await axios.delete(`${USER_SERVICE_URL}/users/${id}`);
      setUsers(users.filter((u) => u.id !== id));
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(err.response?.data?.error || 'Error deleting user');
    }
  };

  const handleProductEdit = (product: Product) => {
    setEditingProductId(product.id);
    setProductForm({ name: product.name, price: String(product.price) });
    setErrorMessage(null);
  };

  const handleProductDelete = async (id: string) => {
    try {
      await axios.delete(`${PRODUCT_SERVICE_URL}/products/${id}`);
      setProducts(products.filter((p) => p.id !== id));
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(err.response?.data?.error || 'Error deleting product');
    }
  };

  const handleOrderEdit = (entry: any) => {
    const id = entry.order?.id || entry.id;
    const userId = entry.order?.userId || entry.userId;
    const productId = entry.order?.productId || entry.productId;
    const quantity = entry.order?.quantity || entry.quantity;
    setEditingOrderId(id);
    setOrderForm({ userId: userId, productId: productId, quantity: Number(quantity) });
    setErrorMessage(null);
  };

  const handleOrderDelete = async (id: string) => {
    try {
      await axios.delete(`${ORDER_SERVICE_URL}/orders/${id}`);
      setOrders(
        orders.filter((entry) => {
          const entryId = entry.order?.id || entry.id;
          return entryId !== id;
        })
      );
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(err.response?.data?.error || 'Error deleting order');
    }
  };

  return (
    <div className="container my-4">
      <h1 className="mb-4 text-center">Secure Microservices Demo</h1>
      {errorMessage && (
        <div className="alert alert-danger" role="alert">
          {errorMessage}
        </div>
      )}
      <div className="row g-4">
        <div className="col-md-4">
          <h2>Add User</h2>
          <form onSubmit={handleUserSubmit} className="border p-3 rounded shadow-sm">
            <div className="mb-3">
              <label className="form-label">Name</label>
              <input
                type="text"
                className="form-control"
                value={userForm.name}
                onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                required
              />
            </div>
            <div className="mb-3">
              <label className="form-label">Email</label>
              <input
                type="email"
                className="form-control"
                value={userForm.email}
                onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary w-100">
              {editingUserId ? 'Update User' : 'Add User'}
            </button>
            {editingUserId && (
              <button
                type="button"
                className="btn btn-secondary w-100 mt-2"
                onClick={() => {
                  setEditingUserId(null);
                  setUserForm({ name: '', email: '' });
                  setErrorMessage(null);
                }}
              >
                Cancel
              </button>
            )}
          </form>
          <h3 className="mt-4">Users</h3>
          <ul className="list-group">
            {users.map((user) => (
              <li
                key={user.id}
                className="list-group-item d-flex justify-content-between align-items-center"
              >
                <span>
                  {user.name}
                  <br />
                  <small className="text-muted">{user.email}</small>
                </span>
                <div>
                  <button
                    className="btn btn-sm btn-outline-secondary me-2"
                    onClick={() => handleUserEdit(user)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-sm btn-outline-danger"
                    onClick={() => handleUserDelete(user.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="col-md-4">
          <h2>Add Product</h2>
          <form onSubmit={handleProductSubmit} className="border p-3 rounded shadow-sm">
            <div className="mb-3">
              <label className="form-label">Name</label>
              <input
                type="text"
                className="form-control"
                value={productForm.name}
                onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                required
              />
            </div>
            <div className="mb-3">
              <label className="form-label">Price</label>
              <input
                type="number"
                className="form-control"
                value={productForm.price}
                onChange={(e) => setProductForm({ ...productForm, price: e.target.value })}
                required
                min="0"
              />
            </div>
            <button type="submit" className="btn btn-primary w-100">
              {editingProductId ? 'Update Product' : 'Add Product'}
            </button>
            {editingProductId && (
              <button
                type="button"
                className="btn btn-secondary w-100 mt-2"
                onClick={() => {
                  setEditingProductId(null);
                  setProductForm({ name: '', price: '' });
                  setErrorMessage(null);
                }}
              >
                Cancel
              </button>
            )}
          </form>
          <h3 className="mt-4">Products</h3>
          <ul className="list-group">
            {products.map((product) => (
              <li
                key={product.id}
                className="list-group-item d-flex justify-content-between align-items-center"
              >
                <span>
                  {product.name}
                  <br />
                  <small className="text-muted">€{product.price.toFixed(2)}</small>
                </span>
                <div>
                  <button
                    className="btn btn-sm btn-outline-secondary me-2"
                    onClick={() => handleProductEdit(product)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-sm btn-outline-danger"
                    onClick={() => handleProductDelete(product.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="col-md-4">
          <h2>Create Order</h2>
          <form onSubmit={handleOrderSubmit} className="border p-3 rounded shadow-sm">
            <div className="mb-3">
              <label className="form-label">User</label>
              <select
                className="form-select"
                value={orderForm.userId}
                onChange={(e) => setOrderForm({ ...orderForm, userId: e.target.value })}
                required
              >
                <option value="">Select User</option>
                {users.map((user) => (
                  <option value={user.id} key={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="mb-3">
              <label className="form-label">Product</label>
              <select
                className="form-select"
                value={orderForm.productId}
                onChange={(e) => setOrderForm({ ...orderForm, productId: e.target.value })}
                required
              >
                <option value="">Select Product</option>
                {products.map((product) => (
                  <option value={product.id} key={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="mb-3">
              <label className="form-label">Quantity</label>
              <input
                type="number"
                className="form-control"
                min="1"
                value={orderForm.quantity}
                onChange={(e) => setOrderForm({ ...orderForm, quantity: Number(e.target.value) })}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary w-100">
              {editingOrderId ? 'Update Order' : 'Create Order'}
            </button>
            {editingOrderId && (
              <button
                type="button"
                className="btn btn-secondary w-100 mt-2"
                onClick={() => {
                  setEditingOrderId(null);
                  setOrderForm({ userId: '', productId: '', quantity: 1 });
                  setErrorMessage(null);
                }}
              >
                Cancel
              </button>
            )}
          </form>
          <h3 className="mt-4">Orders</h3>
          <ul className="list-group">
            {orders.map((entry: any) => {
              const id = entry.order?.id || entry.id;
              const userName = entry.user?.name || entry.userId;
              const productName = entry.product?.name || entry.productId;
              const quantity = entry.order?.quantity || entry.quantity;
              const status = entry.order?.status || entry.status;
              return (
                <li
                  key={id}
                  className="list-group-item d-flex justify-content-between align-items-center"
                >
                  <span>
                    Order: {id}
                    <br />
                    User: {userName}
                    <br />
                    Product: {productName}
                    <br />
                    Qty: {quantity}
                    <br />
                    Status: {status}
                  </span>
                  <div>
                    <button
                      className="btn btn-sm btn-outline-secondary me-2"
                      onClick={() => handleOrderEdit(entry)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-sm btn-outline-danger"
                      onClick={() => handleOrderDelete(id)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default App;