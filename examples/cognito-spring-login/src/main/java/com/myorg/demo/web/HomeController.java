package com.myorg.demo.web;

import java.security.Principal;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class HomeController {

    @GetMapping("/")
    public String index(Principal principal, Model model) {
        model.addAttribute("principal", principal);
        return "index";
    }

    @GetMapping("/me")
    public String me(Principal principal, Model model) {
        model.addAttribute("principal", principal);
        return "me";
    }
}
