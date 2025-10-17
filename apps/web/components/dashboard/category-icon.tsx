'use client';

import {
  ArrowRightLeft,
  Car,
  Gamepad2,
  Home,
  Landmark,
  Plane,
  ShoppingBag,
  Tag,
  Utensils,
} from 'lucide-react';
import React from 'react';

interface CategoryIconProps {
  category: string;
  className?: string;
}

export function CategoryIcon({ category, className }: CategoryIconProps) {
  const iconProps = {
    className: className ?? 'h-4 w-4 text-slate-500',
  };

  switch (category) {
    case 'Food and Drink':
      return <Utensils {...iconProps} />;
    case 'Transport':
      return <Car {...iconProps} />;
    case 'Shops':
      return <ShoppingBag {...iconProps} />;
    case 'Payment':
      return <Landmark {...iconProps} />;
    case 'Transfer':
      return <ArrowRightLeft {...iconProps} />;
    case 'Rent':
      return <Home {...iconProps} />;
    case 'Recreation':
      return <Gamepad2 {...iconProps} />;
    case 'Travel':
      return <Plane {...iconProps} />;
    default:
      return <Tag {...iconProps} />;
  }
}
